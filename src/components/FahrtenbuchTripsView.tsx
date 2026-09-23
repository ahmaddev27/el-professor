import React, { useState, useEffect, useMemo } from 'react';
import { Search, Filter, X, Upload, Trash2, Lock, User, Calendar, Eye, ChevronLeft, ChevronRight, Download } from 'lucide-react';
import { format } from 'date-fns';
import { de } from 'date-fns/locale';
import { useFahrtenbuch, FahrtenbuchImport, FahrtenbuchTrip } from '../hooks/useFahrtenbuch';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import FahrtenbuchImportModal, { DriverOption, CarOption } from './FahrtenbuchImportModal';
import { exportFahrtenbuch } from '../utils/fahrtenbuchExport';
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
  Field,
  Input,
  KpiCard,
  NativeSelect,
  Tooltip,
  cn,
  formatEuro,
  type DataTableColumn,
} from './ui';

interface Props {
  drivers: DriverOption[];
  cars: CarOption[];
}

const MONTH_KEYS: readonly TranslationKey[] = [
  'doc.month.january', 'doc.month.february', 'doc.month.march',     'doc.month.april',
  'doc.month.may',     'doc.month.june',     'doc.month.july',      'doc.month.august',
  'doc.month.september', 'doc.month.october', 'doc.month.november', 'doc.month.december',
];

// The record keys are `plausibility_status` values stored on the trip — data, so
// they stay as they are. Only the labels follow the UI language; they hold
// TranslationKeys resolved with t() at the call site.
const STATUS_LABEL_KEYS: Record<string, TranslationKey> = {
  pending:   'imp.trips.status.pending',
  ok:        'imp.trips.status.ok',
  uncovered: 'imp.trips.status.uncovered',
  overlap:   'imp.trips.status.overlap',
  canceled:  'imp.trips.status.canceled',
};
// How each status is drawn (phase 5). A status always carries its word, from
// STATUS_LABEL_KEYS above; the tone only adds colour. A status the map does not
// know is drawn neutral, as the old map fell back to its 'pending' colours.
const STATUS_TONE: Record<string, 'neutral' | 'positive' | 'caution' | 'critical'> = {
  pending:   'neutral',
  ok:        'positive',
  uncovered: 'caution',
  overlap:   'critical',
  canceled:  'critical',
};

const FahrtenbuchTripsView: React.FC<Props> = ({ drivers, cars }) => {
  const { isAdmin, isSuperAdmin } = useAuth();
  const { success, error: showError } = useToast();
  const { t } = useTranslation();
  const {
    imports, trips,
    loadingImports, loadingTrips,
    fetchImports, fetchTrips, deleteImport,
  } = useFahrtenbuch();

  const [showImportModal, setShowImportModal] = useState(false);
  const [selectedImportId, setSelectedImportId] = useState<string | 'all'>('all');
  const [filterMonth, setFilterMonth] = useState<number>(new Date().getMonth() + 1);
  const [filterYear,  setFilterYear]  = useState<number>(new Date().getFullYear());
  const [filterDriver, setFilterDriver] = useState('');
  const [filterPlate,  setFilterPlate]  = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [showFilters, setShowFilters] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(100);

  useEffect(() => {
    fetchImports();
  }, [fetchImports]);

  useEffect(() => {
    if (selectedImportId === 'all') {
      fetchTrips(undefined, filterMonth, filterYear);
    } else {
      fetchTrips(selectedImportId);
    }
  }, [selectedImportId, filterMonth, filterYear, fetchTrips]);

  const handleAnzeigen = (imp: FahrtenbuchImport) => {
    setFilterMonth(imp.month);
    setFilterYear(imp.year);
    setSelectedImportId(imp.id);
  };

  // Reset page when filters change
  useEffect(() => { setPage(0); }, [searchTerm, filterDriver, filterPlate, filterStatus, selectedImportId, filterMonth, filterYear]);

  const filteredTrips = useMemo(() => {
    return trips.filter(trip => {
      const matchSearch = !searchTerm || (
        trip.original_driver_name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        trip.assigned_driver_name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        (trip.car_identifier || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
        (trip.route_start || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
        (trip.route_end || '').toLowerCase().includes(searchTerm.toLowerCase())
      );
      const matchDriver = !filterDriver || trip.original_driver_name === filterDriver || trip.assigned_driver_name === filterDriver;
      const matchPlate  = !filterPlate  || (trip.car_identifier || '').toLowerCase().includes(filterPlate.toLowerCase());
      const matchStatus = !filterStatus
        || (filterStatus === 'active' ? !trip.is_canceled : trip.plausibility_status === filterStatus);
      return matchSearch && matchDriver && matchPlate && matchStatus;
    });
  }, [trips, searchTerm, filterDriver, filterPlate, filterStatus]);

  const uniqueDrivers = useMemo(() =>
    [...new Set(trips.map(trip => trip.original_driver_name))].sort(), [trips]);

  const uniquePlates = useMemo(() =>
    [...new Set(trips.map(trip => trip.car_identifier).filter(Boolean))].sort() as string[], [trips]);

  // The same file uploaded again: the importer refuses it and offers this.
  const handleOpenExistingImport = (importId: string) => {
    setShowImportModal(false);
    const imp = imports.find(i => i.id === importId);
    if (imp) handleAnzeigen(imp);
    else setSelectedImportId(importId);
  };

  const handleImported = (importId: string) => {
    setShowImportModal(false);
    setSelectedImportId(importId);
    fetchImports();
    fetchTrips(importId);
    success(t('imp.trips.toastImportedTitle'), t('imp.trips.toastImportedBody'));
  };

  const handleDeleteImport = async (id: string) => {
    setDeleting(true);
    try {
      await deleteImport(id);
      setConfirmDeleteId(null);
      if (selectedImportId === id) {
        setSelectedImportId('all');
        fetchTrips(undefined, filterMonth, filterYear);
      }
      success(t('imp.trips.toastDeletedTitle'), t('imp.trips.toastDeletedBody'));
    } catch (err: any) {
      showError(t('common.error'), t('imp.trips.errDelete', { message: err.message || t('imp.error.unknown') }));
    } finally {
      setDeleting(false);
    }
  };

  const totalPrice = filteredTrips.reduce((sum, trip) => sum + trip.price_amount, 0);
  const totalTip   = filteredTrips.reduce((sum, trip) => sum + trip.tip_amount, 0);
  const canceledCount = filteredTrips.filter(trip => trip.is_canceled).length;
  const activeCount   = filteredTrips.length - canceledCount;

  const totalPages = Math.max(1, Math.ceil(filteredTrips.length / pageSize));
  const safePage   = Math.min(page, totalPages - 1);
  const pageTrips  = filteredTrips.slice(safePage * pageSize, (safePage + 1) * pageSize);
  const showFrom   = filteredTrips.length > 0 ? safePage * pageSize + 1 : 0;
  const showTo     = Math.min((safePage + 1) * pageSize, filteredTrips.length);

  // Falls back to the raw stored status so an unmapped value stays visible.
  const statusLabel = (status: string): string => {
    const labelKey = STATUS_LABEL_KEYS[status];
    return labelKey ? t(labelKey) : status;
  };

  // ── Presentation (phase 5) ────────────────────────────────────────────────
  // Everything above is unchanged: the imports and trips the hook loads, the
  // filters, the totals, the paging and the import delete. Below only draws
  // them. The Fahrtenbuch download keeps its onClick as it was — it picks the
  // import and hands the trips to exportFahrtenbuch (utils/fahrtenbuchExport,
  // untouched) — and deleting an import is still offered to admins only.
  //
  // Euro amounts are written through utils/money.ts. toLocaleString with only
  // a minimum of two fraction digits printed a float sum with three
  // ("20.990,855 €"), and the phone cards wrote a US decimal point.
  const euro = (amount: number) => (Number.isFinite(amount) ? formatEuro(amount) : String(amount));
  const importLabel = (imp: FahrtenbuchImport) => `${t(MONTH_KEYS[imp.month - 1])} ${imp.year}`;

  const tripColumns: DataTableColumn<FahrtenbuchTrip>[] = [
    {
      id: 'date',
      header: t('common.date'),
      className: 'whitespace-nowrap font-medium tabular-nums',
      cell: trip => format(new Date(trip.trip_date), 'dd.MM.yyyy'),
    },
    {
      id: 'start',
      header: t('imp.th.start'),
      className: 'whitespace-nowrap tabular-nums',
      cell: trip => (trip.start_time ? trip.start_time.slice(0,5) : '—'),
    },
    {
      id: 'end',
      header: t('imp.th.end'),
      className: 'whitespace-nowrap tabular-nums',
      cell: trip => (trip.end_time ? trip.end_time.slice(0,5) : '—'),
    },
    {
      id: 'originalDriver',
      header: t('imp.th.originalDriver'),
      className: 'whitespace-nowrap',
      cell: trip => (
        <span className="inline-flex items-center gap-1.5">
          <User aria-hidden className="size-3.5 text-fg-subtle" />
          {trip.original_driver_name}
        </span>
      ),
    },
    {
      id: 'assignedDriver',
      header: t('imp.trips.th.assignedDriver'),
      hideBelow: 'lg',
      className: 'whitespace-nowrap',
      cell: trip => {
        const sameDriver = trip.original_driver_name === trip.assigned_driver_name;
        return (
          <span className={sameDriver ? 'text-fg-subtle' : 'font-medium text-brand-text'}>
            {sameDriver ? '—' : trip.assigned_driver_name}
          </span>
        );
      },
    },
    {
      id: 'plate',
      header: t('imp.th.plate'),
      hideBelow: 'md',
      className: 'whitespace-nowrap text-fg-muted',
      cell: trip => trip.car_identifier || '—',
    },
    {
      id: 'fare',
      header: t('imp.trips.th.fare'),
      kind: 'number',
      className: 'font-medium',
      cell: trip => euro(trip.price_amount),
    },
    {
      id: 'tip',
      header: t('imp.th.tip'),
      kind: 'number',
      hideBelow: 'lg',
      className: 'text-fg-muted',
      cell: trip => (trip.tip_amount > 0 ? euro(trip.tip_amount) : '—'),
    },
    {
      id: 'pickup',
      header: t('imp.trips.th.pickup'),
      hideBelow: 'lg',
      className: 'max-w-32 truncate text-fg-muted',
      cell: trip => trip.route_start || '—',
    },
    {
      id: 'destination',
      header: t('imp.trips.th.destination'),
      hideBelow: 'lg',
      className: 'max-w-32 truncate text-fg-muted',
      cell: trip => trip.route_end || '—',
    },
    {
      id: 'status',
      header: t('common.status'),
      hideBelow: 'sm',
      cell: trip => <Badge tone={STATUS_TONE[trip.plausibility_status] ?? 'neutral'}>{statusLabel(trip.plausibility_status)}</Badge>,
    },
    {
      id: 'locked',
      header: <span className="sr-only">{t('imp.trips.immutableTitle')}</span>,
      hideBelow: 'md',
      cell: () => (
        <Tooltip content={t('imp.trips.immutableTitle')}>
          <span tabIndex={0} className="inline-flex rounded-sm text-fg-subtle focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus">
            <Lock aria-label={t('imp.trips.immutableTitle')} role="img" className="size-3.5" />
          </span>
        </Tooltip>
      ),
    },
  ];

  const importButton = (label: string, size?: 'sm') => (
    <Button size={size} onClick={() => setShowImportModal(true)}>
      <Upload aria-hidden /> {label}
    </Button>
  );

  return (
    <div className="space-y-5">
      {/* Toolbar */}
      <div className="flex flex-wrap items-end gap-3 font-ui">
        <div className="relative min-w-48 flex-1">
          <Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" />
          <Input
            type="text"
            aria-label={t('common.search')}
            placeholder={t('imp.trips.searchPlaceholder')}
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
            className="pl-9"
          />
        </div>

        {/* Import selector */}
        <NativeSelect
          aria-label={t('imp.trips.importSelectLabel')}
          containerClassName="w-full sm:w-auto sm:min-w-[180px]"
          value={selectedImportId}
          onChange={e => setSelectedImportId(e.target.value)}
        >
          <option value="all">{t('imp.trips.allImports')}</option>
          {imports.map(imp => (
            <option key={imp.id} value={imp.id}>
              {t(MONTH_KEYS[imp.month - 1])} {imp.year} — {imp.file_name.slice(0, 20)}
            </option>
          ))}
        </NativeSelect>

        {selectedImportId === 'all' && (
          <>
            <NativeSelect aria-label={t('common.month')} containerClassName="w-[calc(50%-0.375rem)] sm:w-36" value={filterMonth} onChange={e => setFilterMonth(Number(e.target.value))}>
              {MONTH_KEYS.map((monthKey, i) => <option key={monthKey} value={i + 1}>{t(monthKey)}</option>)}
            </NativeSelect>
            <NativeSelect aria-label={t('imp.trips.yearLabel')} containerClassName="w-[calc(50%-0.375rem)] sm:w-28" value={filterYear} onChange={e => setFilterYear(Number(e.target.value))}>
              {[2024, 2025, 2026, 2027].map(y => <option key={y} value={y}>{y}</option>)}
            </NativeSelect>
          </>
        )}

        <Button
          variant="secondary"
          aria-pressed={showFilters}
          className={cn(showFilters && 'border-brand/60 bg-brand-soft text-brand-text hover:bg-brand-soft')}
          onClick={() => setShowFilters(!showFilters)}
        >
          <Filter aria-hidden /> {t('imp.trips.filter')}
        </Button>

        {trips.length > 0 && (
          <Button
            variant="secondary"
            onClick={() => {
              const imp = selectedImportId !== 'all'
                ? imports.find(i => i.id === selectedImportId)
                : imports.find(i => i.month === filterMonth && i.year === filterYear);
              exportFahrtenbuch({
                trips,
                month: imp?.month ?? filterMonth,
                year: imp?.year ?? filterYear,
                importFileName: imp?.file_name,
                sourceColumns: imp?.source_columns_json,
                sourceSheetName: imp?.source_sheet_name,
              });
            }}
          >
            <Download aria-hidden /> {t('imp.trips.downloadFahrtenbuch')}
          </Button>
        )}

        {importButton(t('imp.trips.import'))}
      </div>

      {/* Extra filters */}
      {showFilters && (
        <Card className="grid grid-cols-1 items-end gap-4 p-4 font-ui sm:grid-cols-3">
          <Field label={t('common.driver')}>
            <NativeSelect value={filterDriver} onChange={e => setFilterDriver(e.target.value)}>
              <option value="">{t('common.allDrivers')}</option>
              {uniqueDrivers.map(d => <option key={d} value={d}>{d}</option>)}
            </NativeSelect>
          </Field>
          <Field label={t('imp.trips.plate')}>
            <NativeSelect value={filterPlate} onChange={e => setFilterPlate(e.target.value)}>
              <option value="">{t('imp.trips.allPlates')}</option>
              {uniquePlates.map(p => <option key={p} value={p}>{p}</option>)}
            </NativeSelect>
          </Field>
          <Field label={t('common.status')}>
            <NativeSelect value={filterStatus} onChange={e => setFilterStatus(e.target.value)}>
              <option value="">{t('imp.trips.allStatuses')}</option>
              <option value="active">{t('imp.trips.onlyActive')}</option>
              {Object.entries(STATUS_LABEL_KEYS).map(([status, labelKey]) => (
                <option key={status} value={status}>{t(labelKey)}</option>
              ))}
            </NativeSelect>
          </Field>
          {(filterDriver || filterPlate || filterStatus) && (
            <div className="sm:col-span-3">
              <Button variant="ghost" size="sm" className="-ml-2" onClick={() => { setFilterDriver(''); setFilterPlate(''); setFilterStatus(''); }}>
                <X aria-hidden /> {t('imp.trips.reset')}
              </Button>
            </div>
          )}
        </Card>
      )}

      {/* Imports list (when "all") */}
      {selectedImportId === 'all' && imports.length > 0 && (
        <section aria-labelledby="fahrtenbuch-imports-heading" className="grid grid-cols-1 gap-2 font-ui">
          <h2 id="fahrtenbuch-imports-heading" className="text-[13px] font-semibold text-fg-muted">{t('imp.trips.importedFahrtenbuecher')}</h2>
          {imports.map(imp => (
            <div key={imp.id} className="flex flex-col gap-3 rounded-control border border-line bg-raised px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex min-w-0 items-start gap-3">
                <Calendar aria-hidden className="mt-0.5 size-4 shrink-0 text-brand-text" />
                <div className="min-w-0">
                  <p className="text-sm font-medium text-fg">
                    {t(MONTH_KEYS[imp.month - 1])} {imp.year}
                  </p>
                  <p className="break-words text-xs tabular-nums text-fg-muted">
                    {imp.file_name} · {t('imp.trips.tripCount', { count: imp.row_count })} ·{' '}
                    {format(new Date(imp.imported_at), 'dd.MM.yyyy HH:mm')}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2 pl-7 sm:pl-0">
                <Button variant="secondary" size="sm" onClick={() => handleAnzeigen(imp)}>
                  <Eye aria-hidden /> {t('imp.trips.view')}
                  <span className="sr-only"> – {importLabel(imp)}</span>
                </Button>
                {(isAdmin || isSuperAdmin) && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-critical hover:text-critical"
                    onClick={() => setConfirmDeleteId(imp.id)}
                  >
                    <Trash2 aria-hidden /> {t('common.delete')}
                    <span className="sr-only"> – {importLabel(imp)}</span>
                  </Button>
                )}
              </div>
            </div>
          ))}
        </section>
      )}

      {/* Summary bar. The totals are the ones computed above. */}
      {filteredTrips.length > 0 && (
        <div className="grid grid-cols-2 gap-3 font-ui sm:grid-cols-4">
          <KpiCard
            label={t('imp.trips.cardTotal')}
            value={String(filteredTrips.length)}
            caption={canceledCount > 0 ? t('imp.trips.activeAndCanceled', { active: activeCount, canceled: canceledCount }) : undefined}
          />
          <KpiCard label={t('imp.trips.cardTotalPrice')} value={euro(totalPrice)} />
          <KpiCard label={t('imp.trips.cardTotalTip')} value={euro(totalTip)} />
          <KpiCard
            label={t('imp.trips.cardPage')}
            value={`${showFrom}\u2013${showTo}`}
            caption={t('imp.trips.ofTotal', { count: filteredTrips.length })}
          />
        </div>
      )}

      {/* Trips table */}
      {loadingImports || loadingTrips ? (
        <DataTable caption={t('imp.trips.tableCaption')} columns={tripColumns} rows={[]} getRowId={trip => trip.id} loading />
      ) : filteredTrips.length === 0 ? (
        <Card className="font-ui">
          <EmptyState
            icon={Upload}
            title={imports.length === 0 ? t('imp.trips.emptyNoImport') : t('imp.trips.emptyNoTrips')}
            description={imports.length === 0 ? t('imp.trips.emptyHintImport') : t('imp.trips.emptyHintSelect')}
            action={imports.length === 0 ? importButton(t('imp.trips.importFahrtenbuch'), 'sm') : undefined}
          />
        </Card>
      ) : (
        <>
          {/* Desktop table */}
          <DataTable
            className="hidden md:block"
            caption={t('imp.trips.tableCaption')}
            columns={tripColumns}
            rows={pageTrips}
            getRowId={trip => trip.id}
            density="compact"
          />

          {/* Mobile cards: the same fields as before, on a phone */}
          <ul className="grid grid-cols-1 gap-3 font-ui md:hidden">
            {pageTrips.map(trip => {
              return (
                <li key={trip.id} className={cn('grid gap-3 rounded-surface border border-line bg-raised p-4 shadow-raised', trip.is_canceled && 'opacity-70')}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-semibold tabular-nums text-fg">
                        {format(new Date(trip.trip_date), 'dd.MM.yyyy')}
                        {trip.start_time && trip.end_time ? ` · ${trip.start_time.slice(0,5)}–${trip.end_time.slice(0,5)}` : ''}
                      </p>
                      <p className="mt-0.5 flex items-center gap-1 text-sm text-fg-muted">
                        <User aria-hidden className="size-3 shrink-0" /> {trip.original_driver_name}
                      </p>
                    </div>
                    <Badge tone={STATUS_TONE[trip.plausibility_status] ?? 'neutral'}>{statusLabel(trip.plausibility_status)}</Badge>
                  </div>
                  <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                    <div><dt className="inline text-fg-muted">{t('imp.trips.plate')}: </dt><dd className="inline text-fg">{trip.car_identifier || '—'}</dd></div>
                    <div><dt className="inline text-fg-muted">{t('imp.trips.price')}: </dt><dd className="inline tabular-nums text-fg">{euro(trip.price_amount)}</dd></div>
                    {trip.route_start && <div><dt className="inline text-fg-muted">{t('imp.trips.from')}: </dt><dd className="inline text-fg">{trip.route_start}</dd></div>}
                    {trip.route_end   && <div><dt className="inline text-fg-muted">{t('imp.trips.to')}: </dt><dd className="inline text-fg">{trip.route_end}</dd></div>}
                  </dl>
                </li>
              );
            })}
          </ul>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex flex-wrap items-center justify-between gap-3 pt-2 font-ui">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs tabular-nums text-fg-muted">
                  {t('imp.trips.paginationRange', { from: showFrom, to: showTo, total: filteredTrips.length })}
                </span>
                <NativeSelect
                  aria-label={t('imp.trips.pageSizeLabel')}
                  containerClassName="w-40"
                  value={pageSize}
                  onChange={e => { setPageSize(Number(e.target.value)); setPage(0); }}
                >
                  {[50, 100, 200, 500].map(n => (
                    <option key={n} value={n}>{t('imp.trips.perPage', { count: n })}</option>
                  ))}
                </NativeSelect>
              </div>
              <div className="flex items-center gap-1">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setPage(p => Math.max(0, p - 1))}
                  disabled={safePage === 0}
                >
                  <ChevronLeft aria-hidden /> {t('common.back')}
                </Button>
                <span className="px-3 text-xs font-medium tabular-nums text-fg">
                  {safePage + 1} / {totalPages}
                </span>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
                  disabled={safePage >= totalPages - 1}
                >
                  {t('imp.next')} <ChevronRight aria-hidden />
                </Button>
              </div>
            </div>
          )}
        </>
      )}

      {/* Delete confirm. It stays open while the import is deleted, and
          closing it is refused meanwhile, as the old one's disabled
          Abbrechen refused it; Escape and a click outside mean Abbrechen. */}
      <Dialog
        open={Boolean(confirmDeleteId)}
        onOpenChange={open => { if (!open && !deleting) setConfirmDeleteId(null); }}
      >
        <DialogContent className="max-w-md">
          {confirmDeleteId && (() => {
            const targetImport = imports.find(i => i.id === confirmDeleteId);
            return (
              <>
                <DialogHeader>
                  <DialogTitle>{t('imp.trips.deleteConfirmTitle')}</DialogTitle>
                  {targetImport && (
                    <DialogDescription>
                      {t(MONTH_KEYS[targetImport.month - 1])} {targetImport.year} — {targetImport.file_name} ({t('imp.trips.tripCount', { count: targetImport.row_count })})
                    </DialogDescription>
                  )}
                </DialogHeader>
                <Alert tone="critical">
                  {t('imp.trips.deleteConfirmBody')}
                </Alert>
                <DialogFooter>
                  <Button
                    variant="secondary"
                    onClick={() => setConfirmDeleteId(null)}
                    disabled={deleting}
                  >
                    {t('common.cancel')}
                  </Button>
                  <Button
                    variant="danger"
                    onClick={() => handleDeleteImport(confirmDeleteId)}
                    disabled={deleting}
                  >
                    <Trash2 aria-hidden />
                    {deleting ? t('common.deleting') : t('imp.trips.deleteForever')}
                  </Button>
                </DialogFooter>
              </>
            );
          })()}
        </DialogContent>
      </Dialog>

      {/* Import modal */}
      <FahrtenbuchImportModal
        isOpen={showImportModal}
        onClose={() => setShowImportModal(false)}
        onImported={handleImported}
        onOpenExistingImport={handleOpenExistingImport}
        drivers={drivers}
        cars={cars}
        existingImports={imports}
        onDeleteImport={deleteImport}
      />
    </div>
  );
};

export default FahrtenbuchTripsView;
