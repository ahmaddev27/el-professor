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
import { Badge, Button, Input, NativeSelect } from './ui';

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

// ── Presentation (phase 5)

const IMPORT_STATUS_STYLES: Record<ImportStatus, { label: TranslationKey; tone: 'positive' | 'info' | 'neutral' | 'critical' | 'caution' }> = {
  new:       { label: 'hrt.statusNew',       tone: 'positive' },
  update:    { label: 'hrt.statusUpdate',    tone: 'info' },
  duplicate: { label: 'hrt.statusDuplicate', tone: 'neutral' },
  error:     { label: 'common.error',        tone: 'critical' },
  unmatched: { label: 'hrt.statusUnmatched', tone: 'caution' },
};

function StatusBadge({ status }: { status: ImportStatus }) {
  const { t } = useTranslation();
  const s = IMPORT_STATUS_STYLES[status];
  return (
    <Badge tone={s.tone}>
      {t(s.label)}
    </Badge>
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

  // ── Presentation (phase 5)

  return (
    <div
      className="glass-scrim fixed inset-0 z-50 flex items-center justify-center p-4 font-ui"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="glass-strong flex max-h-[90vh] w-full max-w-5xl flex-col rounded-pane">
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between border-b border-line px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="rounded-tile bg-brand-soft p-2">
              <Database size={18} className="text-brand-text" />
            </div>
            <div>
              <h2 className="text-base font-bold text-fg">
                {t('hrt.title')}
              </h2>
              <p className="text-xs text-fg-muted">
                {t('hrt.subtitle')}
              </p>
            </div>
          </div>
          <button onClick={onClose} aria-label={t('common.close')} className="inline-flex items-center justify-center rounded-tight p-1.5 text-fg-muted transition-colors hover:bg-sunken hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus [@media(pointer:coarse)]:min-h-10 [@media(pointer:coarse)]:min-w-10">
            <X size={18} />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex shrink-0 overflow-x-auto border-b border-line" role="tablist">
          {(['import','manage'] as const).map(tabKey => (
            <button key={tabKey} onClick={() => setTab(tabKey)}
              role="tab"
              aria-selected={tab === tabKey}
              className={`-mb-px whitespace-nowrap border-b-2 px-6 py-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus [@media(pointer:coarse)]:min-h-11 ${
                tab === tabKey ? 'border-brand text-brand-text' : 'border-transparent text-fg-muted hover:text-fg'
              }`}>
              {t(tabKey === 'import' ? 'hrt.tabImport' : 'hrt.tabManage')}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 space-y-4 overflow-y-auto p-6">

          {/* ── Import tab ────────────────────────────────────────────────── */}
          {tab === 'import' && (
            <>
              {importSummary && (
                <div className="space-y-2 rounded-tile border border-positive/20 bg-positive-soft p-4">
                  <div className="flex items-center gap-2 text-sm font-semibold text-positive">
                    <CheckCircle2 size={16} /> {t('hrt.importDone')}
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-xs text-fg-muted sm:grid-cols-5">
                    {([
                      { label: 'hrt.summaryImported',  val: importSummary.imported,  color: 'text-positive' },
                      { label: 'hrt.summaryUpdated',   val: importSummary.updated,   color: 'text-info' },
                      { label: 'hrt.summarySkipped',   val: importSummary.skipped,   color: 'text-neutral' },
                      { label: 'hrt.summaryErrors',    val: importSummary.errors,    color: 'text-critical' },
                      { label: 'hrt.summaryUnmatched', val: importSummary.unmatched, color: 'text-caution' },
                    ] as const).map(s => (
                      <div key={s.label} className="text-center">
                        <div className={`text-lg font-bold tabular-nums ${s.color}`}>{s.val}</div>
                        <div>{t(s.label)}</div>
                      </div>
                    ))}
                  </div>
                  <button onClick={() => setImportSummary(null)}
                    className="rounded-chip text-xs text-fg-muted underline hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
                    {t('hrt.startNewImport')}
                  </button>
                </div>
              )}

              {!importSummary && !preview && (
                <div
                  className="cursor-pointer rounded-surface border-2 border-dashed border-line-strong p-10 text-center transition-colors hover:bg-sunken"
                  onDragOver={e => e.preventDefault()}
                  onDrop={handleDrop}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Upload size={28} className="mx-auto mb-3 text-fg-muted" />
                  <p className="mb-1 text-sm font-medium text-fg">
                    {t('hrt.dropzoneTitle')}
                  </p>
                  <p className="text-xs text-fg-muted">
                    {/* The code sample is the literal JSON the importer expects — data, not a label. */}
                    {t('hrt.dropzoneFormatLabel')} <code>dataset_name: "historical_driver_hours_targets"</code>
                  </p>
                  <input ref={fileInputRef} type="file" accept=".json" className="hidden"
                    onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ''; }} />
                </div>
              )}

              {parseError && (
                <div role="alert" className="flex items-start gap-2 rounded-tile border border-critical/20 bg-critical-soft px-4 py-3 text-sm text-critical">
                  <AlertTriangle size={15} className="mt-0.5 shrink-0" /> {parseError}
                </div>
              )}

              {preview && (
                <>
                  {/* Preview header */}
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-fg">
                        {t('hrt.previewTitle', { count: preview.length })}
                      </p>
                      <p className="mt-0.5 text-xs text-fg-muted">
                        {t('hrt.previewImportable', { count: importableCount })}
                        {preview.filter(r => r.status === 'duplicate').length > 0 &&
                          t('hrt.previewDuplicates', { count: preview.filter(r => r.status === 'duplicate').length })}
                      </p>
                    </div>
                    <button onClick={() => { setPreview(null); setParseError(null); }}
                      className="rounded-chip text-xs text-fg-muted underline hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus">
                      {t('hrt.reset')}
                    </button>
                  </div>

                  {/* Negative warning */}
                  {hasNegativeInPreview && (
                    <div role="alert" className="flex items-start gap-3 rounded-tile border border-caution/20 bg-caution-soft px-4 py-3 text-sm text-caution">
                      <AlertTriangle size={15} className="mt-0.5 shrink-0" />
                      <div>
                        <p className="font-semibold">{t('hrt.negativeTitle')}</p>
                        <p className="mt-0.5 text-xs">{t('hrt.negativeBody')}</p>
                        <label className="mt-2 flex cursor-pointer items-center gap-2">
                          <input type="checkbox" checked={negativeConfirmed}
                            className="accent-brand"
                            onChange={e => setNegativeConfirmed(e.target.checked)} />
                          <span className="text-xs">{t('hrt.negativeConfirm')}</span>
                        </label>
                      </div>
                    </div>
                  )}

                  {/* Preview table */}
                  <div className="glass-card relative rounded-surface">
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="bg-wash">
                            {([
                              'common.month', 'hrt.year', 'common.driver',
                              ...HOUR_COLUMN_KEYS, 'common.status',
                            ] as TranslationKey[]).map(h => (
                              <th key={h} className="whitespace-nowrap px-3 py-2 text-start font-semibold text-fg-muted">{t(h)}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {preview.map(row => (
                            <tr key={row.idx} className={`border-t border-line ${
                              row.status === 'error' ? 'bg-critical-soft' :
                                row.status === 'duplicate' ? 'bg-neutral-soft' : ''}`}>
                              {/* row.month is the German month name carried by the JSON payload — data, not a label. */}
                              <td className="px-3 py-2 text-fg">{row.month}</td>
                              <td className="px-3 py-2 tabular-nums text-fg">{row.year}</td>
                              <td className="min-w-40 px-3 py-2 text-fg">
                                {row.status === 'unmatched' ? (
                                  <NativeSelect
                                    value={row.overrideDriverId}
                                    onChange={e => setOverrideDriver(row.idx, e.target.value)}
                                    className="h-8 text-xs"
                                    containerClassName="max-w-[180px]">
                                    <option value="">{t('hrt.selectDriver')}</option>
                                    {drivers.map(d => (
                                      <option key={d.id} value={d.id}>{d.name}</option>
                                    ))}
                                  </NativeSelect>
                                ) : (
                                  <span>{row.driverName}</span>
                                )}
                                {row.errorMsg && <span className="mt-0.5 block text-xs text-critical">{row.errorMsg}</span>}
                              </td>
                              {[row.baseH, row.night25H, row.night40H, row.sunH, row.holH].map((h, i) => (
                                <td key={i} className={`whitespace-nowrap px-3 py-2 text-end font-mono tabular-nums ${h < 0 ? 'text-critical' : 'text-fg'}`}>
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
                    <Button
                      onClick={handleImportConfirm}
                      disabled={!canConfirmImport}>
                      {importing
                        ? <><RefreshCw size={14} className="motion-safe:animate-spin" /> {t('hrt.importing')}</>
                        : <><CheckCircle2 size={14} /> {t('hrt.importCount', { count: importableCount })}</>}
                    </Button>
                  </div>
                </>
              )}
            </>
          )}

          {/* ── Manage tab ────────────────────────────────────────────────── */}
          {tab === 'manage' && (
            <>
              {/* Filters */}
              <div className="glass-card flex flex-wrap items-end gap-3 rounded-surface p-3">
                <Filter size={14} className="mb-3 shrink-0 text-fg-muted" />
                <div>
                  <label className="mb-1 block text-xs text-fg-muted">{t('hrt.year')}</label>
                  <NativeSelect value={filterYear} onChange={e => setFilterYear(+e.target.value)} className="h-9 text-[13px]" containerClassName="min-w-28">
                    {yearOptions.map(y => <option key={y} value={y}>{y}</option>)}
                  </NativeSelect>
                </div>
                <div>
                  <label className="mb-1 block text-xs text-fg-muted">{t('common.month')}</label>
                  <NativeSelect value={filterMonth} onChange={e => setFilterMonth(+e.target.value)} className="h-9 text-[13px]" containerClassName="min-w-36">
                    <option value={0}>{t('hrt.allMonths')}</option>
                    {MONTH_NAME_KEYS.map((key, i) => <option key={key} value={i+1}>{t(key)}</option>)}
                  </NativeSelect>
                </div>
                <div>
                  <label className="mb-1 block text-xs text-fg-muted">{t('common.driver')}</label>
                  <NativeSelect value={filterDriverId} onChange={e => setFilterDriverId(e.target.value)} className="h-9 text-[13px]" containerClassName="min-w-40">
                    <option value="">{t('common.allDrivers')}</option>
                    {drivers.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                  </NativeSelect>
                </div>
                <div>
                  <label className="mb-1 block text-xs text-fg-muted">{t('hrt.assignment')}</label>
                  <NativeSelect value={filterMatched} onChange={e => setFilterMatched(e.target.value as 'all'|'matched'|'unmatched')} className="h-9 text-[13px]" containerClassName="min-w-32">
                    <option value="all">{t('common.all')}</option>
                    <option value="matched">{t('hrt.assigned')}</option>
                    <option value="unmatched">{t('hrt.unassigned')}</option>
                  </NativeSelect>
                </div>
                <Button onClick={loadRecords} disabled={loadingRecords}
                  variant="secondary" size="sm">
                  <RefreshCw size={12} className={loadingRecords ? 'motion-safe:animate-spin' : ''} /> {t('common.update')}
                </Button>
              </div>

              {loadingRecords ? (
                <div className="flex items-center justify-center gap-2 py-8 text-sm text-fg-muted">
                  <RefreshCw size={16} className="motion-safe:animate-spin" /> {t('common.loading')}
                </div>
              ) : records.length === 0 ? (
                <div className="py-10 text-center text-sm text-fg-muted">
                  {t('hrt.noRecords')}
                </div>
              ) : (
                <div className="glass-card relative rounded-surface">
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="bg-wash">
                          <th className="px-3 py-2 text-start font-semibold text-fg-muted">{t('common.month')}</th>
                          <th className="px-3 py-2 text-start font-semibold text-fg-muted">{t('hrt.year')}</th>
                          <th className="min-w-[150px] px-3 py-2 text-start font-semibold text-fg-muted">{t('common.driver')}</th>
                          {HOUR_COLUMN_KEYS.map((key, i) => (
                            <th key={key} className={`px-3 py-2 text-end font-semibold text-fg-muted ${i === 0 ? 'min-w-20' : 'min-w-[75px]'}`}>{t(key)}</th>
                          ))}
                          <th className="min-w-20 px-3 py-2 text-center font-semibold text-fg-muted">{t('common.status')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {records.map(rec => {
                          const saveState = saveStates.get(rec.id);
                          const isUnmatched = !rec.driver_id;
                          return (
                            <tr key={rec.id} className="border-t border-line">
                              {/* rec.month is the stored German month name — data, not a label. */}
                              <td className="px-3 py-1.5 text-fg">{rec.month}</td>
                              <td className="px-3 py-1.5 tabular-nums text-fg">{rec.year}</td>
                              <td className="px-3 py-1.5">
                                {isUnmatched ? (
                                  <div className="flex items-center gap-1.5">
                                    <span className="text-xs text-caution">{rec.driver_name}</span>
                                    <NativeSelect
                                      value=""
                                      onChange={e => updateDriverAssignment(rec, e.target.value)}
                                      className="h-8 text-xs"
                                      containerClassName="max-w-[140px]">
                                      <option value="">{t('hrt.assignDriver')}</option>
                                      {drivers.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                                    </NativeSelect>
                                  </div>
                                ) : (
                                  <span className="font-medium text-fg">
                                    {drivers.find(d => d.id === rec.driver_id)?.name ?? rec.driver_name}
                                  </span>
                                )}
                              </td>
                              {(
                                ['base_hours','night_25_hours','night_0_4_40_hours','sunday_50_hours','holiday_hours'] as const
                              ).map(field => (
                                <td key={field} className="px-2 py-1">
                                  <Input
                                    type="text" inputMode="decimal"
                                    size={1}
                                    value={getEditVal(rec.id, field, rec[field] as number)}
                                    onChange={e => setEditVal(rec.id, field, e.target.value)}
                                    onBlur={e => commitEdit(rec, field, e.target.value)}
                                    placeholder="0,00"
                                    className="h-8 w-[70px] px-2 text-end text-xs"
                                  />
                                </td>
                              ))}
                              <td className="px-3 py-1.5 text-center">
                                {saveState === 'saving' && (
                                  <span className="text-xs text-fg-muted">{t('common.saving')}</span>
                                )}
                                {saveState === 'saved' && (
                                  <span className="flex items-center justify-center gap-1 text-xs text-positive">
                                    <CheckCircle2 size={11} /> {t('hrt.saved')}
                                  </span>
                                )}
                                {saveState === 'error' && (
                                  <span className="inline-flex items-center gap-1 text-xs text-critical"><AlertTriangle size={11} /> {t('common.error')}</span>
                                )}
                                {!saveState && (
                                  <span className="text-xs text-fg-subtle">—</span>
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
        <div className="flex shrink-0 justify-end border-t border-line px-6 py-4">
          <Button onClick={onClose} variant="secondary">
            {t('common.close')}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── Convenience: small inline trigger chip ────────────────────────────────────

export function HourTargetsTrigger({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation();
  return (
    <Button
      onClick={onClick}
      variant="secondary"
      size="sm"
      className="px-3 text-xs">
      <Database size={13} />
      {t('hrt.triggerLabel')}
    </Button>
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
