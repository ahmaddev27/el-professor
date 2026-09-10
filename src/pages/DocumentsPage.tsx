import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { FileText, Clock, ChevronRight, ChevronDown, Receipt, Car, MapPin, ArrowLeft, Trash2, ExternalLink, FileDown, AlertTriangle, Download } from 'lucide-react';
import TrinkgeldQuittungModal from '../components/TrinkgeldQuittungModal';
import MietwagenauftragModal from '../components/MietwagenauftragModal';
import FahrtenbuchTripsView from '../components/FahrtenbuchTripsView';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import type { DriverOption, CarOption } from '../components/FahrtenbuchImportModal';
import { exportStundennachweisAsPdf, toPdfDayRow } from '../utils/stundennachweisPdfExport';
import { useSuperAdmin } from '../contexts/SuperAdminContext';

// ── Types ─────────────────────────────────────────────────────────────────────

interface SavedRecord {
  id: string;
  driver_id: string;
  driver_name: string;
  personalnummer: string | null;
  month: number;
  year: number;
  grundlohn_min: number;
  nachtarbeit_min: number;
  nacht04_min: number;
  samstag_min: number;
  sonntag_min: number;
  feiertag_min: number;
  weihnachten_min: number;
  working_days: number;
  rows_json: unknown[];
  saved_at: string;
  updated_at: string;
  generation_source?: string | null;
  source_import_id?: string | null;
  generated_at?: string | null;
  warnings_json?: string[] | null;
  hourly_rate?: number | null;
  calculated_salary?: number | null;
  pdf_storage_path?: string | null;
  snapshot_hash?: string | null;
}

interface MonthGroup {
  key: string;
  year: number;
  month: number;
  label: string;
  records: SavedRecord[];
  totalMins: number;
  totalGross: number | null;
}

const MONTH_NAMES_DE = [
  'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
];

function minsToDecimal(mins: number): number {
  return Math.round((mins / 60) * 100) / 100;
}

function fmtDec(v: number): string {
  return v.toFixed(2).replace('.', ',');
}

function fmtEuro(v: number | null | undefined): string {
  if (v == null) return '—';
  return v.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
}

type SubView = 'main' | 'fahrtenbuch';

// ── PDF export — uses the shared renderer (Schicht 3, no Samstag column) ─────

function exportSavedPDF(rec: SavedRecord): void {
  const { month, year, driver_name, personalnummer, rows_json } = rec;
  const rows = (rows_json as Record<string, unknown>[]).map(r =>
    toPdfDayRow(r, month, year),
  );
  const totals = {
    grundlohn:   rec.grundlohn_min,
    nachtarbeit: rec.nachtarbeit_min,
    nacht04:     rec.nacht04_min,
    sonntag:     rec.sonntag_min,
    feiertag:    rec.feiertag_min,
    weihnachten: rec.weihnachten_min,
  };
  const warnings = Array.isArray(rec.warnings_json) ? rec.warnings_json : [];
  exportStundennachweisAsPdf(
    { driver: { name: driver_name, personalnummer }, month, year, rows, totals, warnings },
    `Stundennachweis_${driver_name.replace(/\s+/g, '_')}_${MONTH_NAMES_DE[month - 1]}_${year}`,
  );
}

function totalMins(rec: SavedRecord): number {
  return rec.grundlohn_min + rec.nachtarbeit_min + rec.nacht04_min +
    rec.samstag_min + rec.sonntag_min + rec.feiertag_min + rec.weihnachten_min;
}

// ── Component ─────────────────────────────────────────────────────────────────

const DocumentsPage: React.FC = () => {
  const navigate = useNavigate();
  const { effectiveCompanyId: companyId } = useSuperAdmin();
  const [isTrinkgeldModalOpen, setIsTrinkgeldModalOpen] = useState(false);
  const [isMietwagenModalOpen, setIsMietwagenModalOpen] = useState(false);
  const [subView, setSubView] = useState<SubView>('main');

  // Drivers and cars for Fahrtenbuch matching
  const [drivers, setDrivers] = useState<DriverOption[]>([]);
  const [cars, setCars] = useState<CarOption[]>([]);

  // Saved Stundennachweise archive
  const [savedRecords, setSavedRecords] = useState<SavedRecord[]>([]);
  const [loadingArchive, setLoadingArchive] = useState(true);

  // Single-row delete
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');

  // Group expand/collapse — keyed by "${year}-${month}"
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const initializedExpand = useRef(false);

  // Group-level delete
  const [deleteGroupKey, setDeleteGroupKey] = useState<string | null>(null);
  const [deletingGroup, setDeletingGroup] = useState(false);
  const [groupDeleteError, setGroupDeleteError] = useState('');

  useEffect(() => {
    if (!companyId) return;
    supabase
      .from('drivers')
      .select('id, name')
      .eq('company_id', companyId)
      .eq('status', 'active')
      .order('name')
      .then(({ data }) => setDrivers((data || []) as DriverOption[]));

    supabase
      .from('cars')
      .select('id, kennzeichen')
      .eq('company_id', companyId)
      .order('kennzeichen')
      .then(({ data }) => setCars(
        (data || []).map((c: { id: string; kennzeichen: string }) => ({
          id: c.id,
          plate: c.kennzeichen,
        }))
      ));
  }, [companyId]);

  const loadArchive = useCallback(async () => {
    if (!companyId) return;
    setLoadingArchive(true);
    const { data } = await supabase
      .from('saved_stundennachweise')
      .select('*')
      .eq('company_id', companyId)
      .order('year', { ascending: false })
      .order('month', { ascending: false })
      .order('driver_name');
    setSavedRecords((data || []) as SavedRecord[]);
    setLoadingArchive(false);
  }, [companyId]);

  useEffect(() => { loadArchive(); }, [loadArchive]);

  // Group records by month/year, sorted newest first, rows sorted by driver_name
  const monthGroups = useMemo<MonthGroup[]>(() => {
    const map = new Map<string, SavedRecord[]>();
    for (const rec of savedRecords) {
      const key = `${rec.year}-${String(rec.month).padStart(2, '0')}`;
      const arr = map.get(key) ?? [];
      arr.push(rec);
      map.set(key, arr);
    }
    const groups: MonthGroup[] = [];
    for (const [key, records] of map) {
      const [yearStr, monthStr] = key.split('-');
      const year = Number(yearStr);
      const month = Number(monthStr);
      const sorted = [...records].sort((a, b) => a.driver_name.localeCompare(b.driver_name, 'de'));
      const groupTotalMins = sorted.reduce((s, r) => s + totalMins(r), 0);
      const grossValues = sorted.map(r => r.calculated_salary ?? null);
      const totalGross = grossValues.every(v => v != null)
        ? Math.round(grossValues.reduce((s, v) => s + (v as number), 0) * 100) / 100
        : null;
      groups.push({
        key,
        year,
        month,
        label: `${MONTH_NAMES_DE[month - 1]} ${year}`,
        records: sorted,
        totalMins: groupTotalMins,
        totalGross,
      });
    }
    // newest first
    groups.sort((a, b) => b.year !== a.year ? b.year - a.year : b.month - a.month);
    return groups;
  }, [savedRecords]);

  // Auto-expand the newest group on first load
  useEffect(() => {
    if (monthGroups.length === 0 || initializedExpand.current) return;
    initializedExpand.current = true;
    setExpandedGroups(new Set([monthGroups[0].key]));
  }, [monthGroups]);

  const toggleGroup = (key: string) => {
    setExpandedGroups(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const handleOpen = (rec: SavedRecord) => {
    navigate('/stundennachweis', { state: { savedRecord: rec } });
  };

  const handlePdf = async (rec: SavedRecord) => {
    if (rec.pdf_storage_path) {
      const { data, error } = await supabase.storage
        .from('stundennachweise-pdfs')
        .createSignedUrl(rec.pdf_storage_path, 300);
      if (!error && data?.signedUrl) {
        const response = await fetch(data.signedUrl);
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `Stundennachweis_${rec.driver_name.replace(/\s+/g, '_')}_${MONTH_NAMES_DE[rec.month - 1]}_${rec.year}.pdf`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        return;
      }
    }
    exportSavedPDF(rec);
  };

  const handleDeleteConfirm = async () => {
    if (!deleteConfirmId || !companyId) return;
    setDeleting(true);
    // Scope by company as well as id: deleting a statutory record by primary key
    // alone leaves the tenant boundary entirely to RLS.
    const { error } = await supabase
      .from('saved_stundennachweise')
      .delete()
      .eq('id', deleteConfirmId)
      .eq('company_id', companyId);
    setDeleting(false);
    if (error) {
      setDeleteError(`Löschen fehlgeschlagen: ${error.message}`);
      return;
    }
    setDeleteConfirmId(null);
    loadArchive();
  };

  const handleDownloadGroup = async (group: MonthGroup) => {
    for (const rec of group.records) {
      await handlePdf(rec);
    }
  };

  const handleDeleteGroupConfirm = async () => {
    if (!deleteGroupKey) return;
    const group = monthGroups.find(g => g.key === deleteGroupKey);
    if (!group) return;
    setDeletingGroup(true);
    setGroupDeleteError('');
    const ids = group.records.map(r => r.id);
    if (!companyId) return;
    const { error } = await supabase
      .from('saved_stundennachweise')
      .delete()
      .in('id', ids)
      .eq('company_id', companyId);
    if (error) {
      setGroupDeleteError(error.message);
      setDeletingGroup(false);
      return;
    }
    setDeleteGroupKey(null);
    setDeletingGroup(false);
    loadArchive();
  };

  const cardBase: React.CSSProperties = {
    background: 'var(--bg-surface)',
    border: '1px solid var(--border)',
    boxShadow: 'var(--shadow-sm)',
  };

  // ── Fahrtenbuch sub-view ───────────────────────────────────────────────────
  if (subView === 'fahrtenbuch') {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-4">
          <button
            onClick={() => setSubView('main')}
            className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm transition-colors"
            style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }}
            onMouseEnter={e => (e.currentTarget.style.borderColor = 'var(--accent)')}
            onMouseLeave={e => (e.currentTarget.style.borderColor = 'var(--border)')}
          >
            <ArrowLeft size={16} /> Dokumente
          </button>
          <div>
            <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>Fahrtenbuch</h1>
            <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>
              Fahrtenbuch importieren und Fahrten verwalten
            </p>
          </div>
        </div>
        <FahrtenbuchTripsView drivers={drivers} cars={cars} />
      </div>
    );
  }

  // ── Confirmation modal for group delete ───────────────────────────────────
  const groupForDelete = deleteGroupKey ? monthGroups.find(g => g.key === deleteGroupKey) : null;

  // ── Main documents view ───────────────────────────────────────────────────
  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="rounded-xl p-6 text-white" style={{ background: 'linear-gradient(to right, var(--accent), var(--accent-hover))', boxShadow: 'var(--shadow-md)' }}>
        <div className="flex items-center space-x-3">
          <div className="bg-white bg-opacity-20 rounded-lg p-2">
            <FileText size={32} />
          </div>
          <div>
            <h1 className="text-3xl font-bold">Dokumente</h1>
            <p className="mt-1" style={{ color: 'rgba(255,255,255,0.8)' }}>
              Stundennachweis, Trinkgeld-Quittung, Mietwagenauftrag und Fahrtenbuch
            </p>
          </div>
        </div>
      </div>

      {/* Document tools */}
      <div>
        <h2 className="text-sm font-semibold uppercase tracking-wider mb-3" style={{ color: 'var(--text-tertiary)' }}>
          Dokument-Tools
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">

          {/* Stundennachweis */}
          <button
            onClick={() => navigate('/stundennachweis')}
            className="text-left rounded-xl p-5 transition-all group"
            style={cardBase}
            onMouseEnter={e => { e.currentTarget.style.boxShadow = 'var(--shadow-md)'; e.currentTarget.style.borderColor = 'var(--accent)'; }}
            onMouseLeave={e => { e.currentTarget.style.boxShadow = 'var(--shadow-sm)'; e.currentTarget.style.borderColor = 'var(--border)'; }}
          >
            <div className="flex items-start justify-between mb-3">
              <div className="rounded-lg p-2.5" style={{ background: 'var(--accent-subtle)' }}>
                <Clock size={22} style={{ color: 'var(--accent-text)' }} />
              </div>
              <ChevronRight size={16} style={{ color: 'var(--text-tertiary)' }} className="mt-1 group-hover:translate-x-0.5 transition-transform" />
            </div>
            <h3 className="font-semibold text-base mb-1" style={{ color: 'var(--text-primary)' }}>Stundennachweis</h3>
            <p className="text-xs leading-relaxed" style={{ color: 'var(--text-tertiary)' }}>
              Monatliche Arbeitszeitnachweise für Fahrer generieren, bearbeiten und als PDF exportieren.
            </p>
            <div className="mt-3 flex items-center gap-1.5">
              <span className="text-xs px-2 py-0.5 rounded-full font-medium" style={{ background: 'var(--accent-subtle)', color: 'var(--accent-text)' }}>Vorlage</span>
              <span className="text-xs px-2 py-0.5 rounded-full font-medium" style={{ background: 'var(--success-subtle)', color: 'var(--success)' }}>PDF Export</span>
            </div>
          </button>

          {/* Trinkgeld Quittung */}
          <button
            onClick={() => setIsTrinkgeldModalOpen(true)}
            className="text-left rounded-xl p-5 transition-all group"
            style={cardBase}
            onMouseEnter={e => { e.currentTarget.style.boxShadow = 'var(--shadow-md)'; e.currentTarget.style.borderColor = 'var(--accent)'; }}
            onMouseLeave={e => { e.currentTarget.style.boxShadow = 'var(--shadow-sm)'; e.currentTarget.style.borderColor = 'var(--border)'; }}
          >
            <div className="flex items-start justify-between mb-3">
              <div className="rounded-lg p-2.5" style={{ background: 'var(--success-subtle)' }}>
                <Receipt size={22} style={{ color: 'var(--success)' }} />
              </div>
              <ChevronRight size={16} style={{ color: 'var(--text-tertiary)' }} className="mt-1 group-hover:translate-x-0.5 transition-transform" />
            </div>
            <h3 className="font-semibold text-base mb-1" style={{ color: 'var(--text-primary)' }}>Trinkgeld Quittung</h3>
            <p className="text-xs leading-relaxed" style={{ color: 'var(--text-tertiary)' }}>
              Formelle Quittung über Trinkgeld-Barzahlung an einen Fahrer für einen gewählten Monat.
            </p>
            <div className="mt-3 flex items-center gap-1.5">
              <span className="text-xs px-2 py-0.5 rounded-full font-medium" style={{ background: 'var(--accent-subtle)', color: 'var(--accent-text)' }}>Vorlage</span>
              <span className="text-xs px-2 py-0.5 rounded-full font-medium" style={{ background: 'var(--success-subtle)', color: 'var(--success)' }}>PDF Export</span>
            </div>
          </button>

          {/* Mietwagenauftrag */}
          <button
            onClick={() => setIsMietwagenModalOpen(true)}
            className="text-left rounded-xl p-5 transition-all group"
            style={cardBase}
            onMouseEnter={e => { e.currentTarget.style.boxShadow = 'var(--shadow-md)'; e.currentTarget.style.borderColor = 'var(--accent)'; }}
            onMouseLeave={e => { e.currentTarget.style.boxShadow = 'var(--shadow-sm)'; e.currentTarget.style.borderColor = 'var(--border)'; }}
          >
            <div className="flex items-start justify-between mb-3">
              <div className="rounded-lg p-2.5" style={{ background: 'var(--warning-subtle)' }}>
                <Car size={22} style={{ color: 'var(--warning)' }} />
              </div>
              <ChevronRight size={16} style={{ color: 'var(--text-tertiary)' }} className="mt-1 group-hover:translate-x-0.5 transition-transform" />
            </div>
            <h3 className="font-semibold text-base mb-1" style={{ color: 'var(--text-primary)' }}>Mietwagenauftrag / Fahrtennachweis</h3>
            <p className="text-xs leading-relaxed" style={{ color: 'var(--text-tertiary)' }}>
              Fahrtennachweis für Personenbeförderung im Mietwagenverkehr.
            </p>
            <div className="mt-3 flex items-center gap-1.5">
              <span className="text-xs px-2 py-0.5 rounded-full font-medium" style={{ background: 'var(--accent-subtle)', color: 'var(--accent-text)' }}>Vorlage</span>
              <span className="text-xs px-2 py-0.5 rounded-full font-medium" style={{ background: 'var(--success-subtle)', color: 'var(--success)' }}>PDF Export</span>
            </div>
          </button>

          {/* Fahrtenbuch */}
          <button
            onClick={() => setSubView('fahrtenbuch')}
            className="text-left rounded-xl p-5 transition-all group"
            style={cardBase}
            onMouseEnter={e => { e.currentTarget.style.boxShadow = 'var(--shadow-md)'; e.currentTarget.style.borderColor = 'var(--accent)'; }}
            onMouseLeave={e => { e.currentTarget.style.boxShadow = 'var(--shadow-sm)'; e.currentTarget.style.borderColor = 'var(--border)'; }}
          >
            <div className="flex items-start justify-between mb-3">
              <div className="rounded-lg p-2.5" style={{ background: 'rgba(16,185,129,0.12)' }}>
                <MapPin size={22} style={{ color: '#059669' }} />
              </div>
              <ChevronRight size={16} style={{ color: 'var(--text-tertiary)' }} className="mt-1 group-hover:translate-x-0.5 transition-transform" />
            </div>
            <h3 className="font-semibold text-base mb-1" style={{ color: 'var(--text-primary)' }}>Fahrtenbuch</h3>
            <p className="text-xs leading-relaxed" style={{ color: 'var(--text-tertiary)' }}>
              Fahrtenbuch importieren und Fahrten später mit dem Stundennachweis abgleichen.
            </p>
            <div className="mt-3 flex items-center gap-1.5">
              <span className="text-xs px-2 py-0.5 rounded-full font-medium" style={{ background: 'rgba(16,185,129,0.12)', color: '#059669' }}>Import</span>
              <span className="text-xs px-2 py-0.5 rounded-full font-medium" style={{ background: 'var(--accent-subtle)', color: 'var(--accent-text)' }}>Excel / CSV</span>
            </div>
          </button>

        </div>
      </div>

      {/* ── Saved Stundennachweise archive ─────────────────────────────────────── */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>
            Gespeicherte Stundennachweise
          </h2>
          {!loadingArchive && savedRecords.length > 0 && (
            <span className="text-xs px-2 py-0.5 rounded-full font-medium" style={{ background: 'var(--accent-subtle)', color: 'var(--accent-text)' }}>
              {savedRecords.length} {savedRecords.length === 1 ? 'Eintrag' : 'Einträge'}
            </span>
          )}
        </div>

        {loadingArchive ? (
          <div className="rounded-xl p-8 text-center text-sm" style={{ border: '1px solid var(--border)', background: 'var(--bg-surface)', color: 'var(--text-tertiary)' }}>
            Lade gespeicherte Stundennachweise…
          </div>
        ) : monthGroups.length === 0 ? (
          <div className="rounded-xl p-8 text-center" style={{ border: '1px solid var(--border)', background: 'var(--bg-surface)' }}>
            <Clock size={32} className="mx-auto mb-3" style={{ color: 'var(--text-tertiary)' }} />
            <p className="text-sm font-medium mb-1" style={{ color: 'var(--text-primary)' }}>Keine gespeicherten Stundennachweise vorhanden.</p>
            <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
              Im Stundennachweis-Tool auf „Speichern" klicken, um einen Nachweis zu archivieren.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {monthGroups.map(group => {
              const isExpanded = expandedGroups.has(group.key);
              return (
                <div key={group.key} className="rounded-xl overflow-hidden" style={{ border: '1px solid var(--border)', background: 'var(--bg-surface)' }}>
                  {/* Group header */}
                  <div
                    className="flex items-center gap-3 px-4 py-3 cursor-pointer select-none"
                    style={{ background: 'var(--bg-muted)', borderBottom: isExpanded ? '1px solid var(--border)' : 'none' }}
                    onClick={() => toggleGroup(group.key)}
                  >
                    {/* Chevron + title */}
                    <div className="flex items-center gap-2 flex-1 min-w-0">
                      {isExpanded
                        ? <ChevronDown size={16} style={{ color: 'var(--text-secondary)', flexShrink: 0 }} />
                        : <ChevronRight size={16} style={{ color: 'var(--text-secondary)', flexShrink: 0 }} />
                      }
                      <span className="font-semibold text-sm" style={{ color: 'var(--text-primary)' }}>
                        {group.label}
                      </span>
                      <span className="text-xs px-2 py-0.5 rounded-full font-medium" style={{ background: 'var(--accent-subtle)', color: 'var(--accent-text)' }}>
                        {group.records.length} {group.records.length === 1 ? 'Eintrag' : 'Einträge'}
                      </span>
                      <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                        {fmtDec(minsToDecimal(group.totalMins))} Std. gesamt
                        {group.totalGross != null && (
                          <span className="ml-2">· {fmtEuro(group.totalGross)} Brutto</span>
                        )}
                      </span>
                    </div>
                    {/* Group actions — stop propagation so click doesn't toggle expand */}
                    <div className="flex items-center gap-2 shrink-0" onClick={e => e.stopPropagation()}>
                      <button
                        onClick={() => handleDownloadGroup(group)}
                        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all"
                        style={{ background: 'var(--success-subtle)', color: 'var(--success)', border: '1px solid transparent' }}
                        onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--success)'; }}
                        onMouseLeave={e => { e.currentTarget.style.borderColor = 'transparent'; }}
                        title={`Alle PDFs für ${group.label} herunterladen`}
                      >
                        <Download size={12} /> Alle herunterladen
                      </button>
                      <button
                        onClick={() => { setGroupDeleteError(''); setDeleteGroupKey(group.key); }}
                        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all"
                        style={{ background: 'var(--error-subtle)', color: 'var(--error)', border: '1px solid transparent' }}
                        onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--error)'; }}
                        onMouseLeave={e => { e.currentTarget.style.borderColor = 'transparent'; }}
                        title={`Alle Einträge für ${group.label} löschen`}
                      >
                        <Trash2 size={12} /> Alle löschen
                      </button>
                    </div>
                  </div>

                  {/* Expanded rows table */}
                  {isExpanded && (
                    <div className="overflow-x-auto">
                      <table className="w-full text-sm">
                        <thead>
                          <tr style={{ background: 'var(--bg-muted)', borderBottom: '1px solid var(--border)' }}>
                            {['Fahrer', 'Personalnr.', 'Gesamtstunden', 'Brutto erwartet', 'Arbeitstage', 'Gespeichert am', 'Aktualisiert am', 'Aktionen'].map(h => (
                              <th key={h} className="px-4 py-2.5 text-left font-semibold text-xs uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>
                                {h}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {group.records.map((rec, idx) => (
                            <tr
                              key={rec.id}
                              style={{
                                borderBottom: idx < group.records.length - 1 ? '1px solid var(--border)' : 'none',
                                background: idx % 2 === 0 ? 'var(--bg-surface)' : 'var(--bg-muted)',
                              }}
                            >
                              <td className="px-4 py-3 font-medium" style={{ color: 'var(--text-primary)' }}>
                                {rec.driver_name}
                                {rec.generation_source === 'fahrtenbuch' && (
                                  <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded font-medium" style={{ background: 'var(--accent-subtle)', color: 'var(--accent-text)' }}>Fahrtenbuch</span>
                                )}
                                {rec.generation_source === 'monatsplanung' && (
                                  <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded font-medium" style={{ background: 'rgba(16,185,129,0.12)', color: '#059669' }}>Planung</span>
                                )}
                              </td>
                              <td className="px-4 py-3 font-mono text-xs" style={{ color: 'var(--text-secondary)' }}>
                                {rec.personalnummer ?? '—'}
                              </td>
                              <td className="px-4 py-3 font-mono" style={{ color: 'var(--text-primary)' }}>
                                {fmtDec(minsToDecimal(totalMins(rec)))} Std.
                              </td>
                              <td className="px-4 py-3 font-mono" style={{ color: rec.calculated_salary != null ? 'var(--text-primary)' : 'var(--text-tertiary)' }}>
                                {fmtEuro(rec.calculated_salary)}
                              </td>
                              <td className="px-4 py-3 text-center" style={{ color: 'var(--text-primary)' }}>
                                {rec.working_days}
                              </td>
                              <td className="px-4 py-3 text-xs" style={{ color: 'var(--text-tertiary)' }}>
                                {rec.saved_at ? new Date(rec.saved_at).toLocaleDateString('de-DE') : '—'}
                              </td>
                              <td className="px-4 py-3 text-xs" style={{ color: 'var(--text-tertiary)' }}>
                                {rec.updated_at ? new Date(rec.updated_at).toLocaleDateString('de-DE') : '—'}
                              </td>
                              <td className="px-4 py-3">
                                <div className="flex items-center gap-1.5">
                                  <button
                                    onClick={() => handleOpen(rec)}
                                    title="Öffnen"
                                    className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all"
                                    style={{ background: 'var(--accent-subtle)', color: 'var(--accent-text)', border: '1px solid transparent' }}
                                    onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--accent)'; }}
                                    onMouseLeave={e => { e.currentTarget.style.borderColor = 'transparent'; }}
                                  >
                                    <ExternalLink size={12} /> Öffnen
                                  </button>
                                  <button
                                    onClick={() => handlePdf(rec)}
                                    title="Als PDF exportieren"
                                    className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all"
                                    style={{ background: 'var(--success-subtle)', color: 'var(--success)', border: '1px solid transparent' }}
                                    onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--success)'; }}
                                    onMouseLeave={e => { e.currentTarget.style.borderColor = 'transparent'; }}
                                  >
                                    <FileDown size={12} /> PDF
                                  </button>
                                  <button
                                    onClick={() => { setDeleteError(''); setDeleteConfirmId(rec.id); }}
                                    title="Löschen"
                                    className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all"
                                    style={{ background: 'var(--error-subtle)', color: 'var(--error)', border: '1px solid transparent' }}
                                    onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--error)'; }}
                                    onMouseLeave={e => { e.currentTarget.style.borderColor = 'transparent'; }}
                                  >
                                    <Trash2 size={12} />
                                  </button>
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Single-row delete confirmation modal */}
      {deleteConfirmId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.5)' }}>
          <div className="rounded-xl p-6 max-w-sm w-full shadow-xl" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}>
            <div className="flex items-center gap-3 mb-4">
              <div className="rounded-lg p-2" style={{ background: 'var(--error-subtle)' }}>
                <AlertTriangle size={20} style={{ color: 'var(--error)' }} />
              </div>
              <h3 className="font-semibold text-base" style={{ color: 'var(--text-primary)' }}>Löschen bestätigen</h3>
            </div>
            <p className="text-sm mb-6" style={{ color: 'var(--text-secondary)' }}>
              Diesen gespeicherten Stundennachweis wirklich löschen? Diese Aktion kann nicht rückgängig gemacht werden.
            </p>
            {deleteError && (
              <div
                className="rounded-lg p-3 mb-4 text-sm"
                style={{ background: 'var(--danger-subtle)', border: '1px solid var(--danger)', color: 'var(--danger)' }}
              >
                {deleteError}
              </div>
            )}
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => { setDeleteConfirmId(null); setDeleteError(''); }}
                disabled={deleting}
                className="px-4 py-2 rounded-lg text-sm font-medium transition-colors"
                style={{ background: 'var(--bg-muted)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}
              >
                Abbrechen
              </button>
              <button
                onClick={handleDeleteConfirm}
                disabled={deleting}
                className="px-4 py-2 rounded-lg text-sm font-medium transition-colors"
                style={{ background: 'var(--error)', color: 'white' }}
              >
                {deleting ? 'Löschen…' : 'Löschen'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Group delete confirmation modal */}
      {deleteGroupKey && groupForDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.5)' }}>
          <div className="rounded-xl p-6 max-w-sm w-full shadow-xl" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}>
            <div className="flex items-center gap-3 mb-4">
              <div className="rounded-lg p-2" style={{ background: 'var(--error-subtle)' }}>
                <AlertTriangle size={20} style={{ color: 'var(--error)' }} />
              </div>
              <h3 className="font-semibold text-base" style={{ color: 'var(--text-primary)' }}>Gruppe löschen bestätigen</h3>
            </div>
            <p className="text-sm mb-2" style={{ color: 'var(--text-secondary)' }}>
              Alle Stundennachweise für <strong>{groupForDelete.label}</strong> wirklich löschen?
            </p>
            <p className="text-sm mb-6" style={{ color: 'var(--text-tertiary)' }}>
              {groupForDelete.records.length} {groupForDelete.records.length === 1 ? 'Eintrag wird' : 'Einträge werden'} gelöscht. Diese Aktion kann nicht rückgängig gemacht werden.
            </p>
            {groupDeleteError && (
              <p className="text-xs mb-4 px-3 py-2 rounded-lg" style={{ background: 'var(--error-subtle)', color: 'var(--error)' }}>
                {groupDeleteError}
              </p>
            )}
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => { setDeleteGroupKey(null); setGroupDeleteError(''); }}
                disabled={deletingGroup}
                className="px-4 py-2 rounded-lg text-sm font-medium transition-colors"
                style={{ background: 'var(--bg-muted)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}
              >
                Abbrechen
              </button>
              <button
                onClick={() => void handleDeleteGroupConfirm()}
                disabled={deletingGroup}
                className="px-4 py-2 rounded-lg text-sm font-medium transition-colors"
                style={{ background: 'var(--error)', color: 'white' }}
              >
                {deletingGroup ? 'Löschen…' : 'Alle löschen'}
              </button>
            </div>
          </div>
        </div>
      )}

      <TrinkgeldQuittungModal isOpen={isTrinkgeldModalOpen} onClose={() => setIsTrinkgeldModalOpen(false)} />
      <MietwagenauftragModal  isOpen={isMietwagenModalOpen} onClose={() => setIsMietwagenModalOpen(false)} />
    </div>
  );
};

export default DocumentsPage;
