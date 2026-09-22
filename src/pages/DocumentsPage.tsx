import React, { useState, useEffect, useCallback, useMemo, useRef, useId } from 'react';
import { Clock, ChevronRight, ChevronDown, Receipt, Car, MapPin, ArrowLeft, Trash2, ExternalLink, FileDown, Download, Banknote, type LucideIcon } from 'lucide-react';
import TrinkgeldQuittungModal from '../components/TrinkgeldQuittungModal';
import MietwagenauftragModal from '../components/MietwagenauftragModal';
import GehaltsquittungModal from '../components/GehaltsquittungModal';
import GehaltsquittungList from '../components/GehaltsquittungList';
import FahrtenbuchTripsView from '../components/FahrtenbuchTripsView';
import { useLocation, useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import type { DriverOption, CarOption } from '../components/FahrtenbuchImportModal';
import { exportStundennachweisAsPdf, toPdfDayRow } from '../utils/stundennachweisPdfExport';
import { useSuperAdmin } from '../contexts/SuperAdminContext';
import { useTranslation } from '../contexts/LanguageContext';
import type { TranslationKey } from '../i18n';
import {
  Alert,
  Badge,
  Button,
  Card,
  DataTable,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  PageHeader,
  Skeleton,
  Tooltip,
  cn,
  formatEuro,
  type DataTableColumn,
} from '../components/ui';

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

// There are deliberately two month-name tables.
//
// MONTH_NAMES_DE is document text: it names the Stundennachweis PDF handed to
// the Steuerberater, so it must stay German in both UI languages and must never
// be routed through the dictionary.
const MONTH_NAMES_DE = [
  'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni',
  'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember',
];

// MONTH_NAME_KEYS is the screen-text counterpart, used only for the archive
// group headings. It holds TranslationKeys because this list is module-level
// and t() is a hook value; every consumer resolves it at the call site.
const MONTH_NAME_KEYS: TranslationKey[] = [
  'doc.month.january', 'doc.month.february', 'doc.month.march',     'doc.month.april',
  'doc.month.may',     'doc.month.june',     'doc.month.july',      'doc.month.august',
  'doc.month.september', 'doc.month.october', 'doc.month.november', 'doc.month.december',
];

function minsToDecimal(mins: number): number {
  return Math.round((mins / 60) * 100) / 100;
}

function fmtDec(v: number): string {
  return v.toFixed(2).replace('.', ',');
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
  const { t, tPlural } = useTranslation();
  const [isTrinkgeldModalOpen, setIsTrinkgeldModalOpen] = useState(false);
  const [isMietwagenModalOpen, setIsMietwagenModalOpen] = useState(false);
  const [isGehaltsquittungModalOpen, setIsGehaltsquittungModalOpen] = useState(false);
  // Bumped when the dialog issues a receipt or attaches a signed copy, so the list reloads.
  const [receiptsVersion, setReceiptsVersion] = useState(0);
  const [subView, setSubView] = useState<SubView>('main');

  // SalaryDetailsModal links a locked payment to its receipt through router state.
  const location = useLocation();
  const focusReceiptState = (location.state as { focusReceiptId?: unknown } | null)?.focusReceiptId;
  const focusReceiptId = typeof focusReceiptState === 'string' ? focusReceiptState : null;

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
        label: `${t(MONTH_NAME_KEYS[month - 1])} ${year}`,
        records: sorted,
        totalMins: groupTotalMins,
        totalGross,
      });
    }
    // newest first
    groups.sort((a, b) => b.year !== a.year ? b.year - a.year : b.month - a.month);
    return groups;
  }, [savedRecords, t]);

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
      setDeleteError(t('doc.deleteFailed', { message: error.message }));
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

  // ── Presentation (phase 5) ────────────────────────────────────────────────
  // Everything above is the screen's logic and is unchanged; everything below
  // only draws it. It adds no arithmetic: a record's hours are the same
  // fmtDec(minsToDecimal(totalMins(rec))) as before, a month's totals are the
  // ones monthGroups computed, and the dates are the same toLocaleDateString
  // calls. A euro amount is only written, through utils/money.ts.

  // A gross the record does not have is "—", as before. formatEuro refuses a
  // value that is not a finite amount; the screen shows such a value as it is
  // rather than going down, as DataTable does for its own currency cells.
  const grossLabel = (amount: number | null | undefined) => {
    if (amount == null) return '—';
    return Number.isFinite(amount) ? formatEuro(amount) : String(amount);
  };

  // ── Fahrtenbuch sub-view ───────────────────────────────────────────────────
  if (subView === 'fahrtenbuch') {
    return (
      <div>
        {/* No font-ui here: the trips view below is still the legacy screen. */}
        <Button variant="ghost" size="sm" className="-ml-2 mb-2" onClick={() => setSubView('main')}>
          <ArrowLeft aria-hidden />
          {t('nav.documents')}
        </Button>
        <PageHeader title={t('doc.fahrtenbuch')} description={t('doc.fahrtenbuchSubtitle')} />
        <FahrtenbuchTripsView drivers={drivers} cars={cars} />
      </div>
    );
  }

  // ── Confirmation modal for group delete ───────────────────────────────────
  const groupForDelete = deleteGroupKey ? monthGroups.find(g => g.key === deleteGroupKey) : null;

  const archiveColumns: DataTableColumn<SavedRecord>[] = [
    {
      id: 'driver',
      header: t('common.driver'),
      // On a phone the name wraps and the paddings tighten, so a row's three
      // actions stay on screen; the month's gross is in its header there.
      className: 'pl-3 pr-2 sm:min-w-[8.5rem] sm:px-4',
      cell: rec => (
        <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
          <span className="font-medium">{rec.driver_name}</span>
          {rec.generation_source === 'fahrtenbuch' && (
            <Badge>{t('doc.fahrtenbuch')}</Badge>
          )}
          {rec.generation_source === 'monatsplanung' && (
            <Badge>{t('doc.badgePlanning')}</Badge>
          )}
        </span>
      ),
    },
    {
      id: 'personalnummer',
      header: t('doc.personalnummer'),
      hideBelow: 'md',
      className: 'tabular-nums text-fg-muted',
      cell: rec => rec.personalnummer ?? '—',
    },
    {
      id: 'hours',
      header: t('doc.totalHours'),
      kind: 'number',
      className: 'px-2 sm:px-4',
      cell: rec => (
        <>
          {fmtDec(minsToDecimal(totalMins(rec)))} {t('doc.hoursShort')}
        </>
      ),
    },
    {
      id: 'gross',
      header: t('doc.grossExpected'),
      kind: 'number',
      hideBelow: 'sm',
      className: 'px-2 sm:px-4',
      cell: rec => (
        <span className={rec.calculated_salary != null ? undefined : 'text-fg-subtle'}>{grossLabel(rec.calculated_salary)}</span>
      ),
    },
    {
      id: 'workingDays',
      header: t('doc.workingDays'),
      kind: 'number',
      hideBelow: 'sm',
      cell: rec => rec.working_days,
    },
    {
      id: 'savedAt',
      header: t('doc.savedAt'),
      hideBelow: 'lg',
      className: 'whitespace-nowrap tabular-nums text-fg-muted',
      cell: rec => (rec.saved_at ? new Date(rec.saved_at).toLocaleDateString('de-DE') : '—'),
    },
    {
      id: 'updatedAt',
      header: t('doc.updatedAt'),
      hideBelow: 'lg',
      className: 'whitespace-nowrap tabular-nums text-fg-muted',
      cell: rec => (rec.updated_at ? new Date(rec.updated_at).toLocaleDateString('de-DE') : '—'),
    },
  ];

  // Delete stays the last action of a row, so it is never the one a hurried
  // tap lands on first.
  const archiveRowActions = (rec: SavedRecord) => (
    <>
      <Tooltip content={t('doc.open')}>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t('doc.openRecordAria', { driver: rec.driver_name })}
          onClick={() => handleOpen(rec)}
        >
          <ExternalLink aria-hidden />
        </Button>
      </Tooltip>
      <Tooltip content={t('doc.exportPdf')}>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t('doc.pdfRecordAria', { driver: rec.driver_name })}
          onClick={() => handlePdf(rec)}
        >
          <FileDown aria-hidden />
        </Button>
      </Tooltip>
      <Tooltip content={t('common.delete')}>
        <Button
          variant="ghost"
          size="icon-sm"
          className="hover:text-critical"
          aria-label={t('doc.deleteRecordAria', { driver: rec.driver_name })}
          onClick={() => { setDeleteError(''); setDeleteConfirmId(rec.id); }}
        >
          <Trash2 aria-hidden />
        </Button>
      </Tooltip>
    </>
  );

  const renderArchive = () => {
    if (loadingArchive) {
      return (
        <Card aria-busy className="grid gap-3 p-5">
          <p className="sr-only">{t('doc.archiveLoading')}</p>
          <Skeleton className="h-5 w-48" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-4/5" />
        </Card>
      );
    }
    if (monthGroups.length === 0) {
      return (
        <Card>
          <EmptyState icon={Clock} title={t('doc.archiveEmpty')} description={t('doc.archiveEmptyHint')} />
        </Card>
      );
    }
    return (
      <div className="grid grid-cols-1 gap-3">
        {monthGroups.map(group => {
          const isExpanded = expandedGroups.has(group.key);
          const Chevron = isExpanded ? ChevronDown : ChevronRight;
          return (
            <Card key={group.key} className="overflow-hidden">
              <div className="flex flex-col gap-3 bg-sunken/60 px-4 py-3 md:flex-row md:items-center">
                <button
                  type="button"
                  onClick={() => toggleGroup(group.key)}
                  aria-expanded={isExpanded}
                  className={cn(
                    'flex min-h-8 min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1 rounded-control text-left [@media(pointer:coarse)]:min-h-11',
                    'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
                  )}
                >
                  <Chevron aria-hidden className="size-4 shrink-0 text-fg-muted" />
                  <span className="text-[15px] font-semibold text-fg">{group.label}</span>
                  <Badge tone="brand">
                    {tPlural({ one: 'doc.entryCount.one', other: 'doc.entryCount.other' }, group.records.length)}
                  </Badge>
                  <span className="w-full pl-6 text-[13px] tabular-nums text-fg-muted sm:w-auto sm:pl-0">
                    {t('doc.hoursTotal', { hours: fmtDec(minsToDecimal(group.totalMins)) })}
                    {group.totalGross != null && (
                      <> · {grossLabel(group.totalGross)} {t('doc.gross')}</>
                    )}
                  </span>
                </button>
                <div className="flex flex-wrap items-center gap-2 pl-6 md:pl-0">
                  <Tooltip content={t('doc.downloadAllTitle', { label: group.label })}>
                    <Button variant="secondary" size="sm" onClick={() => handleDownloadGroup(group)}>
                      <Download aria-hidden />
                      {t('doc.downloadAll')}
                      <span className="sr-only"> – {group.label}</span>
                    </Button>
                  </Tooltip>
                  <Tooltip content={t('doc.deleteAllTitle', { label: group.label })}>
                    <Button
                      variant="secondary"
                      size="sm"
                      className="text-critical hover:text-critical"
                      onClick={() => { setGroupDeleteError(''); setDeleteGroupKey(group.key); }}
                    >
                      <Trash2 aria-hidden />
                      {t('doc.deleteAll')}
                      <span className="sr-only"> – {group.label}</span>
                    </Button>
                  </Tooltip>
                </div>
              </div>
              {isExpanded && (
                <DataTable
                  className="rounded-none border-x-0 border-b-0 shadow-none"
                  caption={t('doc.archiveCaption', { label: group.label })}
                  columns={archiveColumns}
                  rows={group.records}
                  getRowId={rec => rec.id}
                  rowActions={archiveRowActions}
                  rowActionsLabel={t('doc.tableActions')}
                />
              )}
            </Card>
          );
        })}
      </div>
    );
  };

  // ── Main documents view ───────────────────────────────────────────────────
  return (
    // No font-ui on the root: the Trinkgeld and Mietwagen dialogs mounted in it
    // are legacy screens and keep their own type. Each converted block sets it.
    <div>
      <PageHeader title={t('nav.documents')} description={t('doc.headerSubtitle')} />

      <div className="grid grid-cols-1 gap-8">
        <section aria-labelledby="documents-tools-heading" className="grid grid-cols-1 gap-3 font-ui">
          <h2 id="documents-tools-heading" className="text-[15px] font-semibold text-fg">
            {t('doc.toolsHeading')}
          </h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            <ToolCard
              icon={Clock}
              title={t('doc.stundennachweis')}
              description={t('doc.stundennachweisDesc')}
              badges={[t('doc.badgeTemplate'), t('doc.badgePdfExport')]}
              onClick={() => navigate('/stundennachweis')}
            />
            <ToolCard
              icon={Receipt}
              title={t('doc.trinkgeldQuittung')}
              description={t('doc.trinkgeldQuittungDesc')}
              badges={[t('doc.badgeTemplate'), t('doc.badgePdfExport')]}
              onClick={() => setIsTrinkgeldModalOpen(true)}
            />
            <ToolCard
              icon={Banknote}
              title={t('doc.gehaltsquittung')}
              description={t('doc.gehaltsquittungDesc')}
              badges={[t('doc.badgeTemplate'), t('doc.badgePdfExport')]}
              onClick={() => setIsGehaltsquittungModalOpen(true)}
            />
            <ToolCard
              icon={Car}
              title={t('doc.mietwagenauftrag')}
              description={t('doc.mietwagenauftragDesc')}
              badges={[t('doc.badgeTemplate'), t('doc.badgePdfExport')]}
              onClick={() => setIsMietwagenModalOpen(true)}
            />
            <ToolCard
              icon={MapPin}
              title={t('doc.fahrtenbuch')}
              description={t('doc.fahrtenbuchDesc')}
              badges={[t('doc.badgeImport'), 'Excel / CSV']}
              onClick={() => setSubView('fahrtenbuch')}
            />
          </div>
        </section>

        {/* ── Gehaltsquittungen ─────────────────────────────────────────────────── */}
        <GehaltsquittungList
          refreshKey={receiptsVersion}
          focusReceiptId={focusReceiptId}
          onCreate={() => setIsGehaltsquittungModalOpen(true)}
        />

        {/* ── Saved Stundennachweise archive ─────────────────────────────────────── */}
        <section aria-labelledby="documents-archive-heading" className="grid grid-cols-1 gap-3 font-ui">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="documents-archive-heading" className="text-[15px] font-semibold text-fg">
              {t('doc.archiveHeading')}
            </h2>
            {!loadingArchive && savedRecords.length > 0 && (
              <Badge tone="brand">
                {tPlural({ one: 'doc.entryCount.one', other: 'doc.entryCount.other' }, savedRecords.length)}
              </Badge>
            )}
          </div>
          {renderArchive()}
        </section>
      </div>

      {/* Single-row delete confirmation. It stays open while the delete runs and
          shows a failure inside itself, as before, so it is not ConfirmDialog
          (which closes on confirm). Escape and a click outside mean Abbrechen,
          and like Abbrechen they wait while a delete is running. */}
      <Dialog
        open={Boolean(deleteConfirmId)}
        onOpenChange={open => {
          if (!open && !deleting) { setDeleteConfirmId(null); setDeleteError(''); }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('doc.confirmDeleteTitle')}</DialogTitle>
            <DialogDescription>{t('doc.confirmDeleteBody')}</DialogDescription>
          </DialogHeader>
          {deleteError && <Alert tone="critical">{deleteError}</Alert>}
          <DialogFooter>
            <Button
              variant="secondary"
              onClick={() => { setDeleteConfirmId(null); setDeleteError(''); }}
              disabled={deleting}
            >
              {t('common.cancel')}
            </Button>
            <Button variant="danger" onClick={handleDeleteConfirm} disabled={deleting}>
              <Trash2 aria-hidden />
              {deleting ? t('common.deleting') : t('common.delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Group delete confirmation, on the same terms. */}
      <Dialog
        open={Boolean(deleteGroupKey && groupForDelete)}
        onOpenChange={open => {
          if (!open && !deletingGroup) { setDeleteGroupKey(null); setGroupDeleteError(''); }
        }}
      >
        <DialogContent className="max-w-md">
          {groupForDelete ? (
            <>
              <DialogHeader>
                <DialogTitle>{t('doc.confirmDeleteGroupTitle')}</DialogTitle>
                <DialogDescription>
                  {/* Split around the bolded label so both languages keep their word order. */}
                  {t('doc.confirmDeleteGroupBefore')}<strong className="font-semibold text-fg">{groupForDelete.label}</strong>{t('doc.confirmDeleteGroupAfter')}
                </DialogDescription>
              </DialogHeader>
              <p className="text-sm text-fg-muted">
                {tPlural(
                  { one: 'doc.confirmDeleteGroupCount.one', other: 'doc.confirmDeleteGroupCount.other' },
                  groupForDelete.records.length,
                )}
              </p>
              {groupDeleteError && <Alert tone="critical">{groupDeleteError}</Alert>}
              <DialogFooter>
                <Button
                  variant="secondary"
                  onClick={() => { setDeleteGroupKey(null); setGroupDeleteError(''); }}
                  disabled={deletingGroup}
                >
                  {t('common.cancel')}
                </Button>
                <Button variant="danger" onClick={() => void handleDeleteGroupConfirm()} disabled={deletingGroup}>
                  <Trash2 aria-hidden />
                  {deletingGroup ? t('common.deleting') : t('doc.deleteAll')}
                </Button>
              </DialogFooter>
            </>
          ) : null}
        </DialogContent>
      </Dialog>

      <TrinkgeldQuittungModal isOpen={isTrinkgeldModalOpen} onClose={() => setIsTrinkgeldModalOpen(false)} />
      <MietwagenauftragModal  isOpen={isMietwagenModalOpen} onClose={() => setIsMietwagenModalOpen(false)} />
      <GehaltsquittungModal
        open={isGehaltsquittungModalOpen}
        onOpenChange={setIsGehaltsquittungModalOpen}
        onChanged={() => setReceiptsVersion(version => version + 1)}
      />
    </div>
  );
};

/**
 * One document tool: a card that is a single button. Its name is the tool's
 * title and its description is read after it, so the card does not announce
 * its badges as part of its name.
 */
function ToolCard({
  icon: Icon,
  title,
  description,
  badges,
  onClick,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  badges: string[];
  onClick: () => void;
}) {
  const id = useId();
  return (
    <button
      type="button"
      onClick={onClick}
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-description`}
      className={cn(
        'group flex h-full flex-col gap-3 rounded-surface border border-line bg-raised p-5 text-left font-ui text-fg shadow-raised transition-colors',
        'hover:border-brand/60 hover:bg-sunken/40',
        'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
      )}
    >
      <span className="flex items-start justify-between gap-3">
        <span className="flex size-10 items-center justify-center rounded-control bg-brand-soft text-brand-text">
          <Icon aria-hidden className="size-5" />
        </span>
        <ChevronRight aria-hidden className="mt-1 size-4 text-fg-subtle transition-transform motion-safe:group-hover:translate-x-0.5" />
      </span>
      <span className="grid gap-1">
        <span id={`${id}-title`} className="text-[15px] font-semibold leading-snug text-fg">
          {title}
        </span>
        <span id={`${id}-description`} className="text-[13px] leading-relaxed text-fg-muted">
          {description}
        </span>
      </span>
      <span className="mt-auto flex flex-wrap gap-1.5 pt-1">
        {badges.map(badge => (
          <Badge key={badge}>{badge}</Badge>
        ))}
      </span>
    </button>
  );
}

export default DocumentsPage;
