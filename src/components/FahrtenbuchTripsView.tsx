import React, { useState, useEffect, useMemo } from 'react';
import { Search, Filter, X, Upload, Trash2, Lock, User, Calendar, AlertTriangle, Eye, ChevronLeft, ChevronRight, Download } from 'lucide-react';
import { format } from 'date-fns';
import { de } from 'date-fns/locale';
import { useFahrtenbuch, FahrtenbuchImport, FahrtenbuchTrip } from '../hooks/useFahrtenbuch';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../contexts/ToastContext';
import FahrtenbuchImportModal, { DriverOption, CarOption } from './FahrtenbuchImportModal';
import { exportFahrtenbuch } from '../utils/fahrtenbuchExport';
import { useTranslation } from '../contexts/LanguageContext';
import type { TranslationKey } from '../i18n';

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
const STATUS_COLORS: Record<string, { bg: string; text: string }> = {
  pending:   { bg: 'var(--bg-muted)',      text: 'var(--text-tertiary)' },
  ok:        { bg: 'var(--success-subtle)', text: 'var(--success)' },
  uncovered: { bg: 'var(--warning-subtle)', text: 'var(--warning)' },
  overlap:   { bg: 'var(--danger-subtle)',  text: 'var(--danger)' },
  canceled:  { bg: 'var(--danger-subtle)',  text: 'var(--danger)' },
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

  const inputSt: React.CSSProperties = {
    background: 'var(--bg-subtle)', border: '1px solid var(--border)',
    borderRadius: '0.5rem', color: 'var(--text-primary)',
    fontSize: '0.875rem', padding: '0.5rem 0.75rem', outline: 'none',
  };

  return (
    <div className="space-y-5">
      {/* Toolbar */}
      <div className="flex flex-wrap gap-3 items-center">
        <div className="relative flex-1 min-w-48">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2" size={16} style={{ color: 'var(--text-tertiary)' }} />
          <input
            type="text"
            placeholder={t('imp.trips.searchPlaceholder')}
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
            style={{ ...inputSt, paddingLeft: '2.25rem', width: '100%' }}
          />
        </div>

        {/* Import selector */}
        <select
          value={selectedImportId}
          onChange={e => setSelectedImportId(e.target.value)}
          style={{ ...inputSt, minWidth: 180 }}
        >
          <option value="all">{t('imp.trips.allImports')}</option>
          {imports.map(imp => (
            <option key={imp.id} value={imp.id}>
              {t(MONTH_KEYS[imp.month - 1])} {imp.year} — {imp.file_name.slice(0, 20)}
            </option>
          ))}
        </select>

        {selectedImportId === 'all' && (
          <>
            <select value={filterMonth} onChange={e => setFilterMonth(Number(e.target.value))} style={inputSt}>
              {MONTH_KEYS.map((monthKey, i) => <option key={monthKey} value={i + 1}>{t(monthKey)}</option>)}
            </select>
            <select value={filterYear} onChange={e => setFilterYear(Number(e.target.value))} style={inputSt}>
              {[2024, 2025, 2026, 2027].map(y => <option key={y} value={y}>{y}</option>)}
            </select>
          </>
        )}

        <button
          onClick={() => setShowFilters(!showFilters)}
          className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm"
          style={{ background: showFilters ? 'var(--accent-subtle)' : 'var(--bg-surface)', border: '1px solid var(--border)', color: showFilters ? 'var(--accent-text)' : 'var(--text-secondary)' }}
        >
          <Filter size={15} /> {t('imp.trips.filter')}
        </button>

        {trips.length > 0 && (
          <button
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
            className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium"
            style={{ background: 'var(--success-subtle)', color: 'var(--success)', border: '1px solid var(--success)' }}
          >
            <Download size={15} /> {t('imp.trips.downloadFahrtenbuch')}
          </button>
        )}

        <button
          onClick={() => setShowImportModal(true)}
          className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium"
          style={{ background: 'var(--accent)', color: 'var(--text-inverse)' }}
        >
          <Upload size={15} /> {t('imp.trips.import')}
        </button>
      </div>

      {/* Extra filters */}
      {showFilters && (
        <div className="p-4 rounded-lg grid grid-cols-1 sm:grid-cols-3 gap-4" style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)' }}>
          <div>
            <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>{t('common.driver')}</label>
            <select value={filterDriver} onChange={e => setFilterDriver(e.target.value)} style={{ ...inputSt, width: '100%' }}>
              <option value="">{t('common.allDrivers')}</option>
              {uniqueDrivers.map(d => <option key={d} value={d}>{d}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>{t('imp.trips.plate')}</label>
            <select value={filterPlate} onChange={e => setFilterPlate(e.target.value)} style={{ ...inputSt, width: '100%' }}>
              <option value="">{t('imp.trips.allPlates')}</option>
              {uniquePlates.map(p => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>{t('common.status')}</label>
            <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} style={{ ...inputSt, width: '100%' }}>
              <option value="">{t('imp.trips.allStatuses')}</option>
              <option value="active">{t('imp.trips.onlyActive')}</option>
              {Object.entries(STATUS_LABEL_KEYS).map(([status, labelKey]) => (
                <option key={status} value={status}>{t(labelKey)}</option>
              ))}
            </select>
          </div>
          {(filterDriver || filterPlate || filterStatus) && (
            <button onClick={() => { setFilterDriver(''); setFilterPlate(''); setFilterStatus(''); }}
              className="flex items-center gap-1 text-xs" style={{ color: 'var(--text-secondary)' }}>
              <X size={12} /> {t('imp.trips.reset')}
            </button>
          )}
        </div>
      )}

      {/* Imports list (when "all") */}
      {selectedImportId === 'all' && imports.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium" style={{ color: 'var(--text-tertiary)' }}>{t('imp.trips.importedFahrtenbuecher')}</p>
          {imports.map(imp => (
            <div key={imp.id} className="flex items-center justify-between rounded-lg px-4 py-3" style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)' }}>
              <div className="flex items-center gap-3">
                <Calendar size={15} style={{ color: 'var(--accent-text)' }} />
                <div>
                  <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                    {t(MONTH_KEYS[imp.month - 1])} {imp.year}
                  </p>
                  <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                    {imp.file_name} · {t('imp.trips.tripCount', { count: imp.row_count })} ·{' '}
                    {format(new Date(imp.imported_at), 'dd.MM.yyyy HH:mm')}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => handleAnzeigen(imp)}
                  className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg transition-all"
                  style={{ background: 'var(--accent-subtle)', color: 'var(--accent-text)', border: '1px solid var(--accent)' }}
                >
                  <Eye size={13} /> {t('imp.trips.view')}
                </button>
                {(isAdmin || isSuperAdmin) && (
                  <button
                    onClick={() => setConfirmDeleteId(imp.id)}
                    className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg transition-all"
                    style={{ background: 'var(--danger-subtle)', color: 'var(--danger)', border: '1px solid transparent' }}
                    onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--danger)'; }}
                    onMouseLeave={e => { e.currentTarget.style.borderColor = 'transparent'; }}
                  >
                    <Trash2 size={13} /> {t('common.delete')}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Summary bar */}
      {filteredTrips.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {([
            { labelKey: 'imp.trips.cardTotal' as TranslationKey, value: String(filteredTrips.length), sub: canceledCount > 0 ? t('imp.trips.activeAndCanceled', { active: activeCount, canceled: canceledCount }) : undefined, color: 'var(--accent-text)' },
            { labelKey: 'imp.trips.cardTotalPrice' as TranslationKey, value: totalPrice.toLocaleString('de-DE', { minimumFractionDigits: 2 }) + ' \u20AC', sub: undefined, color: 'var(--success)' },
            { labelKey: 'imp.trips.cardTotalTip' as TranslationKey, value: totalTip.toLocaleString('de-DE', { minimumFractionDigits: 2 }) + ' \u20AC', sub: undefined, color: 'var(--text-secondary)' },
            { labelKey: 'imp.trips.cardPage' as TranslationKey, value: `${showFrom}\u2013${showTo}`, sub: t('imp.trips.ofTotal', { count: filteredTrips.length }), color: 'var(--text-primary)' },
          ]).map(c => (
            <div key={c.labelKey} className="rounded-lg p-3 text-center" style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)' }}>
              <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>{t(c.labelKey)}</p>
              <p className="text-lg font-bold" style={{ color: c.color }}>{c.value}</p>
              {c.sub && <p className="text-xs mt-0.5" style={{ color: 'var(--text-tertiary)' }}>{c.sub}</p>}
            </div>
          ))}
        </div>
      )}

      {/* Trips table */}
      {loadingImports || loadingTrips ? (
        <div className="flex items-center justify-center py-16">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2" style={{ borderColor: 'var(--accent)' }} />
        </div>
      ) : filteredTrips.length === 0 ? (
        <div className="text-center py-16 rounded-xl" style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)' }}>
          <Upload size={36} className="mx-auto mb-3 opacity-30" style={{ color: 'var(--text-tertiary)' }} />
          <p className="font-medium" style={{ color: 'var(--text-secondary)' }}>
            {imports.length === 0 ? t('imp.trips.emptyNoImport') : t('imp.trips.emptyNoTrips')}
          </p>
          <p className="text-sm mt-1 max-w-md mx-auto" style={{ color: 'var(--text-tertiary)' }}>
            {imports.length === 0 ? t('imp.trips.emptyHintImport') : t('imp.trips.emptyHintSelect')}
          </p>
          {imports.length === 0 && (
            <button
              onClick={() => setShowImportModal(true)}
              className="mt-4 px-4 py-2 rounded-lg text-sm font-medium"
              style={{ background: 'var(--accent)', color: 'var(--text-inverse)' }}
            >
              {t('imp.trips.importFahrtenbuch')}
            </button>
          )}
        </div>
      ) : (
        <>
          {/* Desktop table */}
          <div className="hidden md:block overflow-x-auto rounded-xl" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}>
            <table className="w-full text-sm">
              <thead style={{ background: 'var(--bg-subtle)' }}>
                <tr>
                  {([
                    'common.date', 'imp.th.start', 'imp.th.end', 'imp.th.originalDriver',
                    'imp.trips.th.assignedDriver', 'imp.th.plate', 'imp.trips.th.fare',
                    'imp.th.tip', 'imp.trips.th.pickup', 'imp.trips.th.destination', 'common.status',
                  ] as TranslationKey[]).map(headerKey => (
                    <th key={headerKey} className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider whitespace-nowrap" style={{ color: 'var(--text-tertiary)' }}>{t(headerKey)}</th>
                  ))}
                  <th className="px-4 py-3" style={{ color: 'var(--text-tertiary)' }}></th>
                </tr>
              </thead>
              <tbody>
                {pageTrips.map((trip, i) => {
                  const st = STATUS_COLORS[trip.plausibility_status] || STATUS_COLORS.pending;
                  const sameDriver = trip.original_driver_name === trip.assigned_driver_name;
                  return (
                    <tr key={trip.id} style={{ borderTop: '1px solid var(--border)', background: i % 2 === 0 ? 'transparent' : 'var(--bg-subtle)', opacity: trip.is_canceled ? 0.7 : 1 }}>
                      <td className="px-4 py-3 whitespace-nowrap font-medium" style={{ color: 'var(--text-primary)' }}>
                        {format(new Date(trip.trip_date), 'dd.MM.yyyy')}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap" style={{ color: trip.start_time ? 'var(--text-primary)' : 'var(--text-tertiary)' }}>{trip.start_time ? trip.start_time.slice(0,5) : '—'}</td>
                      <td className="px-4 py-3 whitespace-nowrap" style={{ color: trip.end_time ? 'var(--text-primary)' : 'var(--text-tertiary)' }}>{trip.end_time ? trip.end_time.slice(0,5) : '—'}</td>
                      <td className="px-4 py-3 whitespace-nowrap" style={{ color: 'var(--text-primary)' }}>
                        <div className="flex items-center gap-1.5">
                          <User size={13} style={{ color: 'var(--text-tertiary)' }} />
                          {trip.original_driver_name}
                        </div>
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap" style={{ color: sameDriver ? 'var(--text-tertiary)' : 'var(--accent-text)' }}>
                        {sameDriver ? '—' : trip.assigned_driver_name}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>
                        {trip.car_identifier || '—'}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-right font-medium" style={{ color: 'var(--success)' }}>
                        {trip.price_amount.toLocaleString('de-DE', { minimumFractionDigits: 2 })} €
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-right" style={{ color: 'var(--text-secondary)' }}>
                        {trip.tip_amount > 0 ? trip.tip_amount.toLocaleString('de-DE', { minimumFractionDigits: 2 }) + ' €' : '—'}
                      </td>
                      <td className="px-4 py-3 max-w-32 truncate" style={{ color: 'var(--text-secondary)' }}>{trip.route_start || '—'}</td>
                      <td className="px-4 py-3 max-w-32 truncate" style={{ color: 'var(--text-secondary)' }}>{trip.route_end || '—'}</td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium" style={{ background: st.bg, color: st.text }}>
                          {statusLabel(trip.plausibility_status)}
                        </span>
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap">
                        <Lock size={13} style={{ color: 'var(--text-tertiary)' }} title={t('imp.trips.immutableTitle')} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Mobile cards */}
          <div className="md:hidden space-y-3">
            {pageTrips.map(trip => {
              const st = STATUS_COLORS[trip.plausibility_status] || STATUS_COLORS.pending;
              return (
                <div key={trip.id} className="rounded-xl p-4 space-y-3" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}>
                  <div className="flex items-start justify-between">
                    <div>
                      <p className="font-semibold" style={{ color: 'var(--text-primary)' }}>
                        {format(new Date(trip.trip_date), 'dd.MM.yyyy')}
                        {trip.start_time && trip.end_time ? ` · ${trip.start_time.slice(0,5)}–${trip.end_time.slice(0,5)}` : ''}
                      </p>
                      <p className="text-sm flex items-center gap-1 mt-0.5" style={{ color: 'var(--text-secondary)' }}>
                        <User size={12} /> {trip.original_driver_name}
                      </p>
                    </div>
                    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium" style={{ background: st.bg, color: st.text }}>
                      {statusLabel(trip.plausibility_status)}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div><span style={{ color: 'var(--text-tertiary)' }}>{t('imp.trips.plate')}: </span><span style={{ color: 'var(--text-primary)' }}>{trip.car_identifier || '—'}</span></div>
                    <div><span style={{ color: 'var(--text-tertiary)' }}>{t('imp.trips.price')}: </span><span style={{ color: 'var(--success)' }}>{trip.price_amount.toFixed(2)} €</span></div>
                    {trip.route_start && <div><span style={{ color: 'var(--text-tertiary)' }}>{t('imp.trips.from')}: </span>{trip.route_start}</div>}
                    {trip.route_end   && <div><span style={{ color: 'var(--text-tertiary)' }}>{t('imp.trips.to')}: </span>{trip.route_end}</div>}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
              <div className="flex items-center gap-2">
                <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                  {t('imp.trips.paginationRange', { from: showFrom, to: showTo, total: filteredTrips.length })}
                </span>
                <select
                  value={pageSize}
                  onChange={e => { setPageSize(Number(e.target.value)); setPage(0); }}
                  className="text-xs rounded-lg px-2 py-1"
                  style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}
                >
                  {[50, 100, 200, 500].map(n => (
                    <option key={n} value={n}>{t('imp.trips.perPage', { count: n })}</option>
                  ))}
                </select>
              </div>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setPage(p => Math.max(0, p - 1))}
                  disabled={safePage === 0}
                  className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium transition-opacity"
                  style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)', color: 'var(--text-secondary)', opacity: safePage === 0 ? 0.4 : 1 }}
                >
                  <ChevronLeft size={14} /> {t('common.back')}
                </button>
                <span className="px-3 py-1.5 text-xs font-medium" style={{ color: 'var(--text-primary)' }}>
                  {safePage + 1} / {totalPages}
                </span>
                <button
                  onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
                  disabled={safePage >= totalPages - 1}
                  className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium transition-opacity"
                  style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)', color: 'var(--text-secondary)', opacity: safePage >= totalPages - 1 ? 0.4 : 1 }}
                >
                  {t('imp.next')} <ChevronRight size={14} />
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {/* Delete confirm */}
      {confirmDeleteId && (() => {
        const targetImport = imports.find(i => i.id === confirmDeleteId);
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.5)' }}>
            <div className="w-full max-w-md rounded-2xl p-6 space-y-4 shadow-xl" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}>
              <div className="flex items-center gap-3">
                <div className="rounded-lg p-2" style={{ background: 'var(--danger-subtle)' }}>
                  <AlertTriangle size={20} style={{ color: 'var(--danger)' }} />
                </div>
                <h3 className="font-semibold text-base" style={{ color: 'var(--text-primary)' }}>
                  {t('imp.trips.deleteConfirmTitle')}
                </h3>
              </div>
              {targetImport && (
                <div className="rounded-lg px-3 py-2 text-sm" style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)', color: 'var(--text-primary)' }}>
                  {t(MONTH_KEYS[targetImport.month - 1])} {targetImport.year} — {targetImport.file_name} ({t('imp.trips.tripCount', { count: targetImport.row_count })})
                </div>
              )}
              <div className="rounded-lg px-3 py-2.5 text-sm" style={{ background: 'var(--danger-subtle)', color: 'var(--danger)' }}>
                {t('imp.trips.deleteConfirmBody')}
              </div>
              <div className="flex gap-3 justify-end pt-1">
                <button
                  onClick={() => setConfirmDeleteId(null)}
                  disabled={deleting}
                  className="px-4 py-2 rounded-lg text-sm font-medium transition-colors"
                  style={{ background: 'var(--bg-muted)', color: 'var(--text-secondary)', border: '1px solid var(--border)' }}
                >
                  {t('common.cancel')}
                </button>
                <button
                  onClick={() => handleDeleteImport(confirmDeleteId)}
                  disabled={deleting}
                  className="px-4 py-2 rounded-lg text-sm font-medium transition-colors flex items-center gap-2"
                  style={{ background: 'var(--danger-solid)', color: 'white' }}
                >
                  <Trash2 size={14} />
                  {deleting ? t('common.deleting') : t('imp.trips.deleteForever')}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Import modal */}
      <FahrtenbuchImportModal
        isOpen={showImportModal}
        onClose={() => setShowImportModal(false)}
        onImported={handleImported}
        drivers={drivers}
        cars={cars}
        existingImports={imports}
        onDeleteImport={deleteImport}
      />
    </div>
  );
};

export default FahrtenbuchTripsView;
