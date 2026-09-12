/**
 * HistoricalHourTargetsManager
 *
 * Reusable modal overlay for managing historical driver payroll-hour targets.
 * Provides two tabs:
 *   - Import: Upload a JSON file, preview rows, match drivers, confirm upsert
 *   - Verwaltung: Browse/filter/edit persisted records with debounced autosave
 *
 * No source_driver_name, no correction logic.
 * Does NOT mutate Fahrtenbuch, assignments, or Brutto-mode state.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  X, Upload, CheckCircle2, AlertTriangle, RefreshCw,
  Database, Filter, ChevronDown,
} from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useTranslation } from '../contexts/LanguageContext';
import type { TranslationKey } from '../i18n';

// ── Constants ─────────────────────────────────────────────────────────────────

// There are deliberately two month tables.
//
// MONTHS_DE is data, not a label: `historical_driver_hour_targets.month` is a
// text column holding the German month name, so this table is what the filter
// query compares against and what the JSON import writes. It must never be
// routed through the dictionary.
const MONTHS_DE = [
  'Januar','Februar','März','April','Mai','Juni',
  'Juli','August','September','Oktober','November','Dezember',
];

// MONTH_NAME_KEYS is the screen-text counterpart, used only for the month
// filter's option labels. It holds TranslationKeys because this list is
// module-level and t() is a hook value; the call site resolves it.
const MONTH_NAME_KEYS: TranslationKey[] = [
  'doc.month.january',   'doc.month.february', 'doc.month.march',    'doc.month.april',
  'doc.month.may',       'doc.month.june',     'doc.month.july',     'doc.month.august',
  'doc.month.september', 'doc.month.october',  'doc.month.november', 'doc.month.december',
];

// Column headers for both the import preview and the management table.
const HOUR_COLUMN_KEYS: TranslationKey[] = [
  'hrt.colBaseWage', 'hrt.colNight25', 'hrt.colNight40', 'hrt.colSunday', 'hrt.colHoliday',
];

// ── Types ─────────────────────────────────────────────────────────────────────

export interface HoursDriver {
  id: string;
  name: string;
  personalnummer: string | null;
}

interface HourTarget {
  id: string;
  driver_id: string | null;
  driver_name: string;
  month: string;
  year: number;
  base_hours: number;
  night_25_hours: number;
  night_0_4_40_hours: number;
  sunday_50_hours: number;
  holiday_hours: number;
}

type ImportStatus = 'new' | 'update' | 'duplicate' | 'error' | 'unmatched';
type SaveState = 'saving' | 'saved' | 'error';

interface PreviewRow {
  idx: number;
  driverName: string;
  month: string;
  year: number;
  baseH: number;
  night25H: number;
  night40H: number;
  sunH: number;
  holH: number;
  status: ImportStatus;
  errorMsg?: string;
  hasNegative: boolean;
  matchedDriverId: string | null;
  overrideDriverId: string;
}

interface ImportSummary {
  imported: number;
  updated: number;
  skipped: number;
  errors: number;
  unmatched: number;
}

export interface Props {
  companyId: string;
  drivers: HoursDriver[];
  defaultMonth?: number;
  defaultYear?: number;
  onClose: () => void;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const normName = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

function parseH(v: unknown): number {
  if (v == null) return 0;
  const n = typeof v === 'string' ? parseFloat(v.replace(',', '.')) : Number(v);
  return isNaN(n) ? 0 : n;
}

function fmtH(h: number): string {
  return h === 0 ? '' : h.toFixed(2).replace('.', ',');
}

function parseGH(s: string): number {
  const n = parseFloat(s.replace(',', '.'));
  return isNaN(n) ? 0 : n;
}

async function upsertTarget(
  companyId: string,
  record: Omit<HourTarget, 'id'> & { company_id?: string },
): Promise<{ wasUpdate: boolean; error: string | null }> {
  let existing: { id: string } | null = null;
  if (record.driver_id) {
    const { data } = await supabase
      .from('historical_driver_hour_targets')
      .select('id')
      .eq('company_id', companyId)
      .eq('driver_id', record.driver_id)
      .eq('month', record.month)
      .eq('year', record.year)
      .maybeSingle();
    existing = data as { id: string } | null;
  } else {
    const { data } = await supabase
      .from('historical_driver_hour_targets')
      .select('id')
      .eq('company_id', companyId)
      .is('driver_id', null)
      .eq('month', record.month)
      .eq('year', record.year)
      .ilike('driver_name', record.driver_name.trim())
      .maybeSingle();
    existing = data as { id: string } | null;
  }
  if (existing) {
    const { error } = await supabase
      .from('historical_driver_hour_targets')
      .update({ ...record, company_id: companyId, updated_at: new Date().toISOString() })
      .eq('id', existing.id);
    return { wasUpdate: true, error: error?.message ?? null };
  }
  const { error } = await supabase
    .from('historical_driver_hour_targets')
    .insert({ ...record, company_id: companyId });
  return { wasUpdate: false, error: error?.message ?? null };
}

// ── Status badge ──────────────────────────────────────────────────────────────

const IMPORT_STATUS_STYLES: Record<ImportStatus, { label: TranslationKey; bg: string; color: string }> = {
  new:       { label: 'hrt.statusNew',       bg: 'rgba(21,128,61,0.1)',    color: '#15803d' },
  update:    { label: 'hrt.statusUpdate',    bg: 'rgba(37,99,235,0.1)',    color: '#2563eb' },
  duplicate: { label: 'hrt.statusDuplicate', bg: 'rgba(107,114,128,0.1)',  color: '#4b5563' },
  error:     { label: 'common.error',        bg: 'rgba(220,38,38,0.1)',    color: '#b91c1c' },
  unmatched: { label: 'hrt.statusUnmatched', bg: 'rgba(217,119,6,0.1)',    color: '#b45309' },
};

function StatusBadge({ status }: { status: ImportStatus }) {
  const { t } = useTranslation();
  const s = IMPORT_STATUS_STYLES[status];
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium whitespace-nowrap"
      style={{ background: s.bg, color: s.color }}>
      {t(s.label)}
    </span>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function HistoricalHourTargetsManager({
  companyId, drivers, defaultMonth, defaultYear, onClose,
}: Props) {
  const { t } = useTranslation();
  const now = new Date();
  const [tab, setTab] = useState<'import' | 'manage'>('import');

  // Import state
  const [parseError, setParseError]             = useState<string | null>(null);
  const [preview, setPreview]                   = useState<PreviewRow[] | null>(null);
  const [negativeConfirmed, setNegativeConfirmed] = useState(false);
  const [importing, setImporting]               = useState(false);
  const [importSummary, setImportSummary]       = useState<ImportSummary | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Manage state
  const [records, setRecords]               = useState<HourTarget[]>([]);
  const [loadingRecords, setLoadingRecords] = useState(false);
  const [filterYear, setFilterYear]         = useState(defaultYear ?? now.getFullYear());
  const [filterMonth, setFilterMonth]       = useState<number>(defaultMonth ?? 0);
  const [filterDriverId, setFilterDriverId] = useState('');
  const [filterMatched, setFilterMatched]   = useState<'all' | 'matched' | 'unmatched'>('all');
  const [localEdits, setLocalEdits]         = useState<Map<string, Record<string, string>>>(new Map());
  const [saveStates, setSaveStates]         = useState<Map<string, SaveState>>(new Map());
  const saveTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const yearOptions = Array.from({ length: 8 }, (_, i) => now.getFullYear() - 6 + i);

  // ── Shared input style ────────────────────────────────────────────────────

  const inp: React.CSSProperties = {
    background: 'var(--bg-subtle)', border: '1px solid var(--border)', borderRadius: '0.375rem',
    color: 'var(--text-primary)', fontSize: '0.8rem', padding: '0.3rem 0.5rem', outline: 'none',
  };

  // ── Load records ──────────────────────────────────────────────────────────

  const loadRecords = useCallback(async () => {
    if (!companyId) return;
    setLoadingRecords(true);
    let q = supabase
      .from('historical_driver_hour_targets')
      .select('id,driver_id,driver_name,month,year,base_hours,night_25_hours,night_0_4_40_hours,sunday_50_hours,holiday_hours')
      .eq('company_id', companyId)
      .eq('year', filterYear)
      .order('month')
      .order('driver_name');
    if (filterMonth > 0) q = q.eq('month', MONTHS_DE[filterMonth - 1]);
    if (filterDriverId) q = q.eq('driver_id', filterDriverId);
    if (filterMatched === 'matched')   q = q.not('driver_id', 'is', null);
    if (filterMatched === 'unmatched') q = q.is('driver_id', null);
    const { data } = await q;
    setRecords((data ?? []) as HourTarget[]);
    setLoadingRecords(false);
  }, [companyId, filterYear, filterMonth, filterDriverId, filterMatched]);

  useEffect(() => { loadRecords(); }, [loadRecords]);

  // ── JSON import ───────────────────────────────────────────────────────────

  const checkExistingRecords = useCallback(async (rows: PreviewRow[]) => {
    const updates = new Map<number, true>();
    const toCheck = rows.filter(r => r.status === 'new' && r.matchedDriverId);
    for (const row of toCheck) {
      const { data } = await supabase
        .from('historical_driver_hour_targets')
        .select('id')
        .eq('company_id', companyId)
        .eq('driver_id', row.matchedDriverId!)
        .eq('month', row.month)
        .eq('year', row.year)
        .maybeSingle();
      if (data) updates.set(row.idx, true);
    }
    if (updates.size > 0) {
      setPreview(prev => prev?.map(r =>
        updates.has(r.idx) ? { ...r, status: 'update' as ImportStatus } : r
      ) ?? null);
    }
  }, [companyId]);

  const handleFile = useCallback((file: File) => {
    setParseError(null);
    setPreview(null);
    setImportSummary(null);
    setNegativeConfirmed(false);

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const json: any = JSON.parse(e.target?.result as string);
        if (!json.entries || !Array.isArray(json.entries)) {
          setParseError(t('hrt.jsonInvalidFormat'));
          return;
        }
        const seen = new Map<string, number>();
        const rows: PreviewRow[] = [];

        for (let i = 0; i < json.entries.length; i++) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const entry: any = json.entries[i];
          const errors: string[] = [];
          // The interpolated names are JSON/database field names, not labels.
          if (!entry.driver_name || typeof entry.driver_name !== 'string') errors.push(t('hrt.fieldMissing', { field: 'driver_name' }));
          if (!entry.month || typeof entry.month !== 'string') errors.push(t('hrt.fieldMissing', { field: 'month' }));
          if (entry.year == null || (typeof entry.year !== 'number' && typeof entry.year !== 'string'))
            errors.push(t('hrt.fieldMissing', { field: 'year' }));

          if (errors.length > 0) {
            rows.push({
              idx: i, driverName: entry.driver_name ?? t('hrt.rowLabel', { number: i + 1 }),
              month: entry.month ?? '?', year: Number(entry.year) || 0,
              baseH: 0, night25H: 0, night40H: 0, sunH: 0, holH: 0,
              status: 'error', errorMsg: errors.join('; '), hasNegative: false,
              matchedDriverId: null, overrideDriverId: '',
            });
            continue;
          }

          const baseH    = parseH(entry.hours?.base_hours);
          const night25H = parseH(entry.hours?.night_25_hours);
          const night40H = parseH(entry.hours?.night_0_4_40_hours);
          const sunH     = parseH(entry.hours?.sunday_50_hours);
          const holH     = parseH(entry.hours?.holiday_hours);
          const hasNeg   = baseH < 0 || night25H < 0 || night40H < 0 || sunH < 0 || holH < 0;

          const key = `${normName(entry.driver_name)}:${entry.month}:${entry.year}`;
          const isDuplicate = seen.has(key);
          if (!isDuplicate) seen.set(key, i);

          const matched = drivers.find(d => normName(d.name) === normName(entry.driver_name)) ?? null;
          const status: ImportStatus = isDuplicate ? 'duplicate' : (matched ? 'new' : 'unmatched');

          rows.push({
            idx: i, driverName: entry.driver_name, month: entry.month, year: Number(entry.year),
            baseH, night25H, night40H, sunH, holH,
            status, errorMsg: undefined, hasNegative: hasNeg,
            matchedDriverId: matched?.id ?? null, overrideDriverId: '',
          });
        }

        setPreview(rows);
        checkExistingRecords(rows);
      } catch (err) {
        setParseError(t('hrt.jsonSyntaxError', { message: err instanceof Error ? err.message : String(err) }));
      }
    };
    reader.readAsText(file);
  }, [drivers, checkExistingRecords, t]);

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  };

  const handleImportConfirm = useCallback(async () => {
    if (!preview) return;
    setImporting(true);
    let imported = 0, updated = 0, skipped = 0, errors = 0, unmatched = 0;

    for (const row of preview) {
      if (row.status === 'error') { errors++; continue; }
      if (row.status === 'duplicate') { skipped++; continue; }

      const driverId = row.matchedDriverId ?? (row.overrideDriverId || null);
      if (!driverId && row.status === 'unmatched') { unmatched++; continue; }

      const { wasUpdate, error } = await upsertTarget(companyId, {
        driver_id: driverId,
        driver_name: row.driverName,
        month: row.month,
        year: row.year,
        base_hours:          Math.max(0, row.baseH),
        night_25_hours:      Math.max(0, row.night25H),
        night_0_4_40_hours:  Math.max(0, row.night40H),
        sunday_50_hours:     Math.max(0, row.sunH),
        holiday_hours:       Math.max(0, row.holH),
      });
      if (error) { errors++; }
      else if (wasUpdate) updated++;
      else imported++;
    }

    setImportSummary({ imported, updated, skipped, errors, unmatched });
    setPreview(null);
    setImporting(false);
    await loadRecords();
    setTab('manage');
  }, [preview, companyId, loadRecords]);

  // ── Preview: update override driver for unmatched row ─────────────────────

  const setOverrideDriver = (idx: number, driverId: string) => {
    setPreview(prev => prev?.map(r =>
      r.idx === idx ? { ...r, overrideDriverId: driverId, matchedDriverId: driverId || null } : r
    ) ?? null);
  };

  // ── Manage table – autosave ───────────────────────────────────────────────

  const scheduleAutosave = useCallback((recordId: string, updates: Record<string, number>) => {
    const existing = saveTimers.current.get(recordId);
    if (existing) clearTimeout(existing);
    setSaveStates(prev => new Map(prev).set(recordId, 'saving'));
    const timer = setTimeout(async () => {
      const { error } = await supabase
        .from('historical_driver_hour_targets')
        .update({ ...updates, updated_at: new Date().toISOString() })
        .eq('id', recordId);
      setSaveStates(prev => new Map(prev).set(recordId, error ? 'error' : 'saved'));
      setTimeout(() => setSaveStates(prev => { const m = new Map(prev); m.delete(recordId); return m; }), 2000);
      saveTimers.current.delete(recordId);
    }, 800);
    saveTimers.current.set(recordId, timer);
  }, []);

  function getEditVal(id: string, field: string, dbVal: number): string {
    return localEdits.get(id)?.[field] ?? fmtH(dbVal);
  }

  function setEditVal(id: string, field: string, val: string) {
    setLocalEdits(prev => {
      const m = new Map(prev);
      m.set(id, { ...(m.get(id) ?? {}), [field]: val });
      return m;
    });
  }

  function commitEdit(record: HourTarget, field: string, val: string) {
    const num = parseGH(val);
    setEditVal(record.id, field, fmtH(num));
    setRecords(prev => prev.map(r => r.id === record.id ? { ...r, [field]: num } : r));
    scheduleAutosave(record.id, { [field]: num });
  }

  const updateDriverAssignment = useCallback(async (record: HourTarget, driverId: string) => {
    const driver = drivers.find(d => d.id === driverId);
    if (!driver) return;
    await supabase
      .from('historical_driver_hour_targets')
      .update({ driver_id: driverId, driver_name: driver.name, updated_at: new Date().toISOString() })
      .eq('id', record.id);
    setRecords(prev => prev.map(r =>
      r.id === record.id ? { ...r, driver_id: driverId, driver_name: driver.name } : r
    ));
  }, [drivers]);

  // ── Derived ────────────────────────────────────────────────────────────────

  const hasNegativeInPreview = preview?.some(r => r.hasNegative && r.status !== 'error' && r.status !== 'duplicate') ?? false;
  const canConfirmImport = !importing && !!preview && preview.length > 0 &&
    (!hasNegativeInPreview || negativeConfirmed);
  const importableCount = preview?.filter(r => r.status !== 'error' && r.status !== 'duplicate').length ?? 0;

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(2px)' }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="flex flex-col rounded-2xl shadow-2xl w-full max-w-5xl"
        style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', maxHeight: '90vh' }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b shrink-0" style={{ borderColor: 'var(--border)' }}>
          <div className="flex items-center gap-3">
            <div className="rounded-xl p-2" style={{ background: 'rgba(37,99,235,0.1)' }}>
              <Database size={18} style={{ color: '#2563eb' }} />
            </div>
            <div>
              <h2 className="text-base font-bold" style={{ color: 'var(--text-primary)' }}>
                {t('hrt.title')}
              </h2>
              <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                {t('hrt.subtitle')}
              </p>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg transition-colors hover:opacity-70"
            style={{ color: 'var(--text-secondary)' }}>
            <X size={18} />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b shrink-0" style={{ borderColor: 'var(--border)' }}>
          {(['import','manage'] as const).map(tabKey => (
            <button key={tabKey} onClick={() => setTab(tabKey)}
              className="px-6 py-3 text-sm font-medium transition-colors"
              style={{
                color: tab === tabKey ? '#2563eb' : 'var(--text-secondary)',
                borderBottom: tab === tabKey ? '2px solid #2563eb' : '2px solid transparent',
              }}>
              {t(tabKey === 'import' ? 'hrt.tabImport' : 'hrt.tabManage')}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-4">

          {/* ── Import tab ────────────────────────────────────────────────── */}
          {tab === 'import' && (
            <>
              {importSummary && (
                <div className="rounded-2xl p-4 space-y-2" style={{ background: 'rgba(21,128,61,0.06)', border: '1px solid rgba(21,128,61,0.2)' }}>
                  <div className="flex items-center gap-2 font-semibold text-sm" style={{ color: '#15803d' }}>
                    <CheckCircle2 size={16} /> {t('hrt.importDone')}
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-xs" style={{ color: 'var(--text-secondary)' }}>
                    {([
                      { label: 'hrt.summaryImported',  val: importSummary.imported,  color: '#15803d' },
                      { label: 'hrt.summaryUpdated',   val: importSummary.updated,   color: '#2563eb' },
                      { label: 'hrt.summarySkipped',   val: importSummary.skipped,   color: '#4b5563' },
                      { label: 'hrt.summaryErrors',    val: importSummary.errors,    color: '#b91c1c' },
                      { label: 'hrt.summaryUnmatched', val: importSummary.unmatched, color: '#b45309' },
                    ] as const).map(s => (
                      <div key={s.label} className="text-center">
                        <div className="text-lg font-bold" style={{ color: s.color }}>{s.val}</div>
                        <div>{t(s.label)}</div>
                      </div>
                    ))}
                  </div>
                  <button onClick={() => setImportSummary(null)}
                    className="text-xs underline" style={{ color: 'var(--text-secondary)' }}>
                    {t('hrt.startNewImport')}
                  </button>
                </div>
              )}

              {!importSummary && !preview && (
                <div
                  className="rounded-2xl border-2 border-dashed p-10 text-center cursor-pointer transition-colors hover:opacity-80"
                  style={{ borderColor: 'var(--border)' }}
                  onDragOver={e => e.preventDefault()}
                  onDrop={handleDrop}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Upload size={28} className="mx-auto mb-3" style={{ color: 'var(--text-secondary)' }} />
                  <p className="text-sm font-medium mb-1" style={{ color: 'var(--text-primary)' }}>
                    {t('hrt.dropzoneTitle')}
                  </p>
                  <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                    {/* The code sample is the literal JSON the importer expects — data, not a label. */}
                    {t('hrt.dropzoneFormatLabel')} <code>dataset_name: "historical_driver_hours_targets"</code>
                  </p>
                  <input ref={fileInputRef} type="file" accept=".json" className="hidden"
                    onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ''; }} />
                </div>
              )}

              {parseError && (
                <div className="rounded-xl px-4 py-3 flex items-start gap-2 text-sm"
                  style={{ background: 'rgba(220,38,38,0.06)', border: '1px solid rgba(220,38,38,0.2)', color: '#b91c1c' }}>
                  <AlertTriangle size={15} className="shrink-0 mt-0.5" /> {parseError}
                </div>
              )}

              {preview && (
                <>
                  {/* Preview header */}
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                        {t('hrt.previewTitle', { count: preview.length })}
                      </p>
                      <p className="text-xs mt-0.5" style={{ color: 'var(--text-secondary)' }}>
                        {t('hrt.previewImportable', { count: importableCount })}
                        {preview.filter(r => r.status === 'duplicate').length > 0 &&
                          t('hrt.previewDuplicates', { count: preview.filter(r => r.status === 'duplicate').length })}
                      </p>
                    </div>
                    <button onClick={() => { setPreview(null); setParseError(null); }}
                      className="text-xs underline" style={{ color: 'var(--text-secondary)' }}>
                      {t('hrt.reset')}
                    </button>
                  </div>

                  {/* Negative warning */}
                  {hasNegativeInPreview && (
                    <div className="rounded-xl px-4 py-3 flex items-start gap-3 text-sm"
                      style={{ background: 'rgba(217,119,6,0.06)', border: '1px solid rgba(217,119,6,0.2)', color: '#b45309' }}>
                      <AlertTriangle size={15} className="shrink-0 mt-0.5" />
                      <div>
                        <p className="font-semibold">{t('hrt.negativeTitle')}</p>
                        <p className="text-xs mt-0.5">{t('hrt.negativeBody')}</p>
                        <label className="flex items-center gap-2 mt-2 cursor-pointer">
                          <input type="checkbox" checked={negativeConfirmed}
                            onChange={e => setNegativeConfirmed(e.target.checked)} />
                          <span className="text-xs">{t('hrt.negativeConfirm')}</span>
                        </label>
                      </div>
                    </div>
                  )}

                  {/* Preview table */}
                  <div className="rounded-2xl overflow-hidden" style={{ border: '1px solid var(--border)' }}>
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead>
                          <tr style={{ background: 'var(--bg-subtle)' }}>
                            {([
                              'common.month', 'hrt.year', 'common.driver',
                              ...HOUR_COLUMN_KEYS, 'common.status',
                            ] as TranslationKey[]).map(h => (
                              <th key={h} className="px-3 py-2 text-left font-semibold whitespace-nowrap"
                                style={{ color: 'var(--text-secondary)' }}>{t(h)}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {preview.map(row => (
                            <tr key={row.idx} style={{ borderTop: '1px solid var(--border)',
                              background: row.status === 'error' ? 'rgba(220,38,38,0.03)' :
                                row.status === 'duplicate' ? 'rgba(107,114,128,0.03)' : undefined }}>
                              {/* row.month is the German month name carried by the JSON payload — data, not a label. */}
                              <td className="px-3 py-2" style={{ color: 'var(--text-primary)' }}>{row.month}</td>
                              <td className="px-3 py-2" style={{ color: 'var(--text-primary)' }}>{row.year}</td>
                              <td className="px-3 py-2" style={{ color: 'var(--text-primary)', minWidth: 160 }}>
                                {row.status === 'unmatched' ? (
                                  <select
                                    value={row.overrideDriverId}
                                    onChange={e => setOverrideDriver(row.idx, e.target.value)}
                                    style={{ ...inp, fontSize: '0.75rem', maxWidth: 180 }}>
                                    <option value="">{t('hrt.selectDriver')}</option>
                                    {drivers.map(d => (
                                      <option key={d.id} value={d.id}>{d.name}</option>
                                    ))}
                                  </select>
                                ) : (
                                  <span>{row.driverName}</span>
                                )}
                                {row.errorMsg && <span className="block text-xs mt-0.5" style={{ color: '#b91c1c' }}>{row.errorMsg}</span>}
                              </td>
                              {[row.baseH, row.night25H, row.night40H, row.sunH, row.holH].map((h, i) => (
                                <td key={i} className="px-3 py-2 font-mono text-right"
                                  style={{ color: h < 0 ? '#b91c1c' : 'var(--text-primary)' }}>
                                  {h !== 0 ? h.toFixed(2).replace('.', ',') : ''}
                                </td>
                              ))}
                              <td className="px-3 py-2"><StatusBadge status={row.status} /></td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  <div className="flex justify-end">
                    <button
                      onClick={handleImportConfirm}
                      disabled={!canConfirmImport}
                      className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold transition-all hover:brightness-110 disabled:opacity-40"
                      style={{ background: '#2563eb', color: '#fff' }}>
                      {importing
                        ? <><RefreshCw size={14} className="animate-spin" /> {t('hrt.importing')}</>
                        : <><CheckCircle2 size={14} /> {t('hrt.importCount', { count: importableCount })}</>}
                    </button>
                  </div>
                </>
              )}
            </>
          )}

          {/* ── Manage tab ────────────────────────────────────────────────── */}
          {tab === 'manage' && (
            <>
              {/* Filters */}
              <div className="flex flex-wrap items-end gap-3 p-3 rounded-2xl" style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)' }}>
                <Filter size={14} className="mt-1.5 shrink-0" style={{ color: 'var(--text-secondary)' }} />
                <div>
                  <label className="block text-xs mb-1" style={{ color: 'var(--text-secondary)' }}>{t('hrt.year')}</label>
                  <select value={filterYear} onChange={e => setFilterYear(+e.target.value)} style={inp}>
                    {yearOptions.map(y => <option key={y} value={y}>{y}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs mb-1" style={{ color: 'var(--text-secondary)' }}>{t('common.month')}</label>
                  <select value={filterMonth} onChange={e => setFilterMonth(+e.target.value)} style={inp}>
                    <option value={0}>{t('hrt.allMonths')}</option>
                    {MONTH_NAME_KEYS.map((key, i) => <option key={key} value={i+1}>{t(key)}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs mb-1" style={{ color: 'var(--text-secondary)' }}>{t('common.driver')}</label>
                  <select value={filterDriverId} onChange={e => setFilterDriverId(e.target.value)} style={inp}>
                    <option value="">{t('common.allDrivers')}</option>
                    {drivers.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs mb-1" style={{ color: 'var(--text-secondary)' }}>{t('hrt.assignment')}</label>
                  <select value={filterMatched} onChange={e => setFilterMatched(e.target.value as 'all'|'matched'|'unmatched')} style={inp}>
                    <option value="all">{t('common.all')}</option>
                    <option value="matched">{t('hrt.assigned')}</option>
                    <option value="unmatched">{t('hrt.unassigned')}</option>
                  </select>
                </div>
                <button onClick={loadRecords} disabled={loadingRecords}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors hover:opacity-80"
                  style={{ background: 'var(--border)', color: 'var(--text-primary)' }}>
                  <RefreshCw size={12} className={loadingRecords ? 'animate-spin' : ''} /> {t('common.update')}
                </button>
              </div>

              {loadingRecords ? (
                <div className="flex items-center gap-2 py-8 justify-center text-sm" style={{ color: 'var(--text-secondary)' }}>
                  <RefreshCw size={16} className="animate-spin" /> {t('common.loading')}
                </div>
              ) : records.length === 0 ? (
                <div className="text-center py-10 text-sm" style={{ color: 'var(--text-secondary)' }}>
                  {t('hrt.noRecords')}
                </div>
              ) : (
                <div className="rounded-2xl overflow-hidden" style={{ border: '1px solid var(--border)' }}>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr style={{ background: 'var(--bg-subtle)' }}>
                          <th className="px-3 py-2 text-left font-semibold" style={{ color: 'var(--text-secondary)' }}>{t('common.month')}</th>
                          <th className="px-3 py-2 text-left font-semibold" style={{ color: 'var(--text-secondary)' }}>{t('hrt.year')}</th>
                          <th className="px-3 py-2 text-left font-semibold" style={{ color: 'var(--text-secondary)', minWidth: 150 }}>{t('common.driver')}</th>
                          {HOUR_COLUMN_KEYS.map((key, i) => (
                            <th key={key} className="px-3 py-2 text-right font-semibold"
                              style={{ color: 'var(--text-secondary)', minWidth: i === 0 ? 80 : 75 }}>{t(key)}</th>
                          ))}
                          <th className="px-3 py-2 text-center font-semibold" style={{ color: 'var(--text-secondary)', minWidth: 80 }}>{t('common.status')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {records.map(rec => {
                          const saveState = saveStates.get(rec.id);
                          const isUnmatched = !rec.driver_id;
                          return (
                            <tr key={rec.id} style={{ borderTop: '1px solid var(--border)' }}>
                              {/* rec.month is the stored German month name — data, not a label. */}
                              <td className="px-3 py-1.5" style={{ color: 'var(--text-primary)' }}>{rec.month}</td>
                              <td className="px-3 py-1.5" style={{ color: 'var(--text-primary)' }}>{rec.year}</td>
                              <td className="px-3 py-1.5">
                                {isUnmatched ? (
                                  <div className="flex items-center gap-1.5">
                                    <span className="text-xs" style={{ color: '#b45309' }}>{rec.driver_name}</span>
                                    <select
                                      value=""
                                      onChange={e => updateDriverAssignment(rec, e.target.value)}
                                      style={{ ...inp, fontSize: '0.7rem', maxWidth: 140 }}>
                                      <option value="">{t('hrt.assignDriver')}</option>
                                      {drivers.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                                    </select>
                                  </div>
                                ) : (
                                  <span style={{ color: 'var(--text-primary)', fontWeight: 500 }}>
                                    {drivers.find(d => d.id === rec.driver_id)?.name ?? rec.driver_name}
                                  </span>
                                )}
                              </td>
                              {(
                                ['base_hours','night_25_hours','night_0_4_40_hours','sunday_50_hours','holiday_hours'] as const
                              ).map(field => (
                                <td key={field} className="px-2 py-1">
                                  <input
                                    type="text" inputMode="decimal"
                                    value={getEditVal(rec.id, field, rec[field] as number)}
                                    onChange={e => setEditVal(rec.id, field, e.target.value)}
                                    onBlur={e => commitEdit(rec, field, e.target.value)}
                                    placeholder="0,00"
                                    style={{ ...inp, textAlign: 'right', width: 70 }}
                                  />
                                </td>
                              ))}
                              <td className="px-3 py-1.5 text-center">
                                {saveState === 'saving' && (
                                  <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>{t('common.saving')}</span>
                                )}
                                {saveState === 'saved' && (
                                  <span className="text-xs flex items-center justify-center gap-1" style={{ color: '#15803d' }}>
                                    <CheckCircle2 size={11} /> {t('hrt.saved')}
                                  </span>
                                )}
                                {saveState === 'error' && (
                                  <span className="text-xs" style={{ color: '#b91c1c' }}>{t('common.error')}</span>
                                )}
                                {!saveState && (
                                  <span className="text-xs" style={{ color: 'var(--text-secondary)', opacity: 0.5 }}>—</span>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </>
          )}

        </div>

        {/* Footer */}
        <div className="flex justify-end px-6 py-4 border-t shrink-0" style={{ borderColor: 'var(--border)' }}>
          <button onClick={onClose}
            className="px-5 py-2 rounded-xl text-sm font-semibold transition-all hover:opacity-80"
            style={{ background: 'var(--bg-subtle)', color: 'var(--text-primary)', border: '1px solid var(--border)' }}>
            {t('common.close')}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Convenience: small inline trigger chip ────────────────────────────────────

export function HourTargetsTrigger({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation();
  return (
    <button
      onClick={onClick}
      className="inline-flex items-center gap-2 px-3 py-1.5 rounded-xl text-xs font-medium transition-all hover:brightness-110"
      style={{ background: 'rgba(37,99,235,0.08)', color: '#2563eb', border: '1px solid rgba(37,99,235,0.2)' }}>
      <Database size={13} />
      {t('hrt.triggerLabel')}
    </button>
  );
}

// ── Save-as-targets helper (used externally by the wizard) ─────────────────────

export async function saveDriverConfigsAsTargets(
  companyId: string,
  monthName: string,
  year: number,
  configs: Array<{
    driverId: string;
    driverName: string;
    targetBaseH: number;
    targetNacht25H: number;
    targetNacht40H: number;
    targetSundayH: number;
    targetHolidayH: number;
  }>,
): Promise<{ saved: number; errors: number }> {
  let saved = 0, errors = 0;
  for (const c of configs) {
    const { error } = await upsertTarget(companyId, {
      driver_id: c.driverId,
      driver_name: c.driverName,
      month: monthName,
      year,
      base_hours: c.targetBaseH,
      night_25_hours: c.targetNacht25H,
      night_0_4_40_hours: c.targetNacht40H,
      sunday_50_hours: c.targetSundayH,
      holiday_hours: c.targetHolidayH,
    });
    if (error) errors++; else saved++;
  }
  return { saved, errors };
}
