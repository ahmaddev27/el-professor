import React, { useState, useEffect, useRef } from 'react';
import { Plus, Wrench, Calendar, AlertCircle, CheckCircle, CreditCard as Edit2, Trash2, Download } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useToast } from '../contexts/ToastContext';
import { getWeeksOfMonth, getWeekNumberForDate, type WeekOfMonth } from '../utils/weekCalculations';
import WerkstattCheckModal from '../components/WerkstattCheckModal';
import ConfirmationModal from '../components/ConfirmationModal';
import { format } from 'date-fns';
import { useColumnPickerExport } from '../contexts/ExportPickerContext';
import { useSuperAdmin } from '../contexts/SuperAdminContext';
import { useTranslation } from '../contexts/LanguageContext';

interface WerkstattCheck {
  id: string;
  car_id: string;
  week_number: number;
  year: number;
  check_date: string;
  status: 'positive' | 'negative' | 'repaired';
  notes: string;
  repair_notes: string | null;
  oil_status: string | null;
  km_stand: number;
  car?: { kennzeichen: string };
}

/**
 * The week the screen is showing, resolved from the month it is showing.
 *
 * THE RULE PRESERVED: a business week belongs to the month containing its
 * MONDAY (`utils/weekCalculations.ts`), and a `weekNumber` is that Monday's
 * 1-based ordinal *inside that business month* — 1..5. It is not an ISO
 * Kalenderwoche. Week 1 of October 2026 is 05.10.–11.10.; week 1 of November
 * 2026 is 02.11.–08.11. So a `weekNumber` names a date range only together with
 * its month, and the rows read, the week named in the filter band and the week
 * named in the filename must all be resolved from the SAME (month, weekNumber)
 * pair — never one from the pair and another from a second, lagging copy.
 *
 * That is exactly what went wrong. `weeks` was `useState`, written by the effect
 * that watches `selectedMonth`, and `loadChecks` read it while its own effect
 * depended on `[selectedMonth, selectedWeek]` alone. Change the month while the
 * selected week is 1 and the load effect runs on the same commit, with the
 * PREVIOUS month's `weeks` still in state; it finds that month's week 1 and
 * loads its rows. The reset to week 1 then changes nothing, so the deps never
 * move and the load never repeats. The header, the dropdown, the filter band and
 * the filename all said the new month while the rows were the old month's — and
 * because no read had failed, there was no error and no toast anywhere.
 *
 * The fix is to stop keeping a second copy: `weeks` is derived at render and
 * this function re-derives the range from the two values the effect already
 * depends on, so no dependency array can be stale.
 */
export function resolveWerkstattWeek(anchor: Date, weekNumber: number): WeekOfMonth | null {
  return getWeeksOfMonth(anchor).find(week => week.weekNumber === weekNumber) ?? null;
}

export default function WerkstattPage() {
  const { t } = useTranslation();
  const exportPicker = useColumnPickerExport();
  const [checks, setChecks] = useState<WerkstattCheck[]>([]);
  const [filteredChecks, setFilteredChecks] = useState<WerkstattCheck[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedMonth, setSelectedMonth] = useState(new Date());
  /**
   * Today's week, so the first load asks for the week the screen is already
   * showing. The effect below computes the same number for the mounting month,
   * so it sets no new value and the mount makes exactly one query. It used to
   * start at 1 and be corrected by that effect — which is a no-op whenever
   * today's week *is* 1, leaving the first (and only) load with a week the
   * `weeks` state did not hold yet: no query at all, an empty list and an empty
   * export, about one week in four.
   */
  const [selectedWeek, setSelectedWeek] = useState<number>(() => getWeekNumberForDate(new Date()));
  /**
   * Derived, never state. A `useState` copy is written one render *after*
   * `selectedMonth` changes, and `loadChecks` read exactly that lagging copy.
   * Deriving it also gives the week dropdown its options on the first render.
   */
  const weeks = getWeeksOfMonth(selectedMonth);
  const [statusFilter, setStatusFilter] = useState<'all' | 'positive' | 'negative' | 'repaired'>('all');
  const [showModal, setShowModal] = useState(false);
  const [selectedCheck, setSelectedCheck] = useState<WerkstattCheck | null>(null);
  const [checkToDelete, setCheckToDelete] = useState<WerkstattCheck | null>(null);
  /**
   * The reason the last load failed, or null. THE RULE: a figure whose load
   * failed is not shown and not exported — an empty list under the new week's
   * name is a claim that the week holds no checks. It carries the reason rather
   * than a bare boolean only because the Werkstatt module owns no
   * "…and therefore nothing is shown" sentence of its own, and the reason is
   * what the toast already says; it is stored raw so a language switch cannot
   * leave a sentence in the language it was thrown in.
   */
  const [loadFailed, setLoadFailed] = useState<string | null>(null);
  /**
   * Which load is the newest. A month change fires the load effect twice — once
   * for the month, once for the week it resets — so two reads are in flight in
   * the ordinary case and the slower one must not be allowed to land last.
   */
  const loadSequence = useRef(0);
  const { showToast } = useToast();
  const { effectiveCompanyId: companyId } = useSuperAdmin();

  useEffect(() => {
    const today = new Date();
    if (today.getMonth() === selectedMonth.getMonth() && today.getFullYear() === selectedMonth.getFullYear()) {
      setSelectedWeek(getWeekNumberForDate(today));
    } else {
      setSelectedWeek(1);
    }
  }, [selectedMonth]);

  useEffect(() => { loadChecks(); }, [selectedMonth, selectedWeek]);
  useEffect(() => { filterChecks(); }, [checks, statusFilter]);

  const loadChecks = async () => {
    const sequence = loadSequence.current + 1;
    loadSequence.current = sequence;
    // Only the newest load may write state; an older answer that lands later is
    // dropped rather than allowed to overwrite the week now on screen.
    const isNewest = () => loadSequence.current === sequence;
    try {
      setLoading(true);
      setLoadFailed(null);
      // Re-derived from the two values this load's effect depends on, so it can
      // never read a `weeks` copy belonging to the month before this one.
      const weekData = resolveWerkstattWeek(selectedMonth, selectedWeek);
      if (!weekData) { if (isNewest()) setChecks([]); return; }

      const { data, error } = await supabase
        .from('werkstatt_checks')
        .select('*, car:cars(kennzeichen)')
        .eq('company_id', companyId)
        .gte('check_date', format(weekData.firstDay, 'yyyy-MM-dd'))
        .lte('check_date', format(weekData.lastDay, 'yyyy-MM-dd'))
        .order('check_date', { ascending: false });

      if (error) throw error;
      if (isNewest()) setChecks(data || []);
    } catch (error: any) {
      if (!isNewest()) return;
      // The rows of the week that loaded last must not survive under the name of
      // the week that failed: the list, the cards and the export all say "this
      // week", so the previous week's plates read as this week's checks.
      setChecks([]);
      setLoadFailed(error?.message ? String(error.message) : '');
      showToast('error', t('werkstatt.errorLoadChecks', { error: error.message }));
    } finally {
      if (isNewest()) setLoading(false);
    }
  };

  const filterChecks = () => {
    if (statusFilter === 'all') {
      const order = { negative: 0, repaired: 1, positive: 2 };
      setFilteredChecks([...checks].sort((a, b) => order[a.status] - order[b.status]));
    } else {
      setFilteredChecks(checks.filter(c => c.status === statusFilter));
    }
  };

  const handleMonthChange = (direction: 'prev' | 'next') => {
    const newMonth = new Date(selectedMonth);
    newMonth.setMonth(selectedMonth.getMonth() + (direction === 'next' ? 1 : -1));
    setSelectedMonth(newMonth);
  };

  const handleDelete = async () => {
    if (!checkToDelete) return;
    try {
      const { error } = await supabase.from('werkstatt_checks').delete().eq('id', checkToDelete.id);
      if (error) throw error;
      showToast('success', t('werkstatt.deleted'));
      loadChecks();
    } catch (error: any) {
      showToast('error', t('werkstatt.deleteFailedReason', { error: error.message }));
    } finally {
      setCheckToDelete(null);
    }
  };

  const getStatusConfig = (status: string) => {
    switch (status) {
      case 'positive': return {
        icon: <CheckCircle className="w-5 h-5" style={{ color: 'var(--success)' }} />,
        bg: 'var(--success-subtle)', border: 'rgba(5,150,105,0.3)', label: t('werkstatt.positive'),
      };
      case 'negative': return {
        icon: <AlertCircle className="w-5 h-5" style={{ color: 'var(--danger)' }} />,
        bg: 'var(--danger-subtle)', border: 'rgba(220,38,38,0.3)', label: t('werkstatt.negative'),
      };
      case 'repaired': return {
        icon: <Wrench className="w-5 h-5" style={{ color: 'var(--accent-text)' }} />,
        bg: 'var(--accent-subtle)', border: 'rgba(37,99,235,0.3)', label: t('werkstatt.repaired'),
      };
      default: return { icon: null, bg: 'var(--bg-subtle)', border: 'var(--border)', label: status };
    }
  };

  function handleExport() {
    // Second wall for the rule above: the button is disabled while the load
    // failed, and a caller that gets past it still writes no file. A sheet of
    // zero rows under this week's name is the same false claim as an empty list.
    if (loadFailed !== null) return;
    const monthLabel = selectedMonth.toLocaleDateString('de-DE', { month: 'long', year: 'numeric' });
    const weekInfo = resolveWerkstattWeek(selectedMonth, selectedWeek);
    const filters: string[] = [
      t('werkstatt.filterMonth', { value: monthLabel }),
      // `common.weekNumber` is "Woche {number}" — the words the dropdown and the
      // Belege filename use. `werkstatt.calendarWeek` was "KW {number}", and KW
      // is *Kalenderwoche*: for the third week of August 2026 (17.08.–23.08.,
      // ISO week 34) "KW 3" named mid-January to anyone who reads German.
      t('werkstatt.filterPeriod', { value: weekInfo?.label ?? t('common.weekNumber', { number: selectedWeek }) }),
    ];
    if (statusFilter !== 'all') {
      const labels: Record<string, string> = { positive: t('werkstatt.positive'), negative: t('werkstatt.negative'), repaired: t('werkstatt.repaired') };
      filters.push(t('werkstatt.filterStatus', { value: labels[statusFilter] ?? statusFilter }));
    }

    exportPicker.table('werkstatt', {
      filename: `werkstatt_${format(selectedMonth, 'yyyy-MM')}_Woche${selectedWeek}`,
      sheetTitle: t('werkstatt.checksTitle'),
      moduleName: t('nav.werkstatt'),
      filterSummary: filters,
      columns: [
        { key: 'check_date',  label: t('common.date'),         width: 14, format: v => new Date(v as string).toLocaleDateString('de-DE') },
        { key: 'kennzeichen', label: t('werkstatt.plate'),    width: 16 },
        { key: 'status',      label: t('common.status'),         width: 14, format: v => ({ positive: t('werkstatt.positive'), negative: t('werkstatt.negative'), repaired: t('werkstatt.repaired') }[v as string] ?? String(v)) },
        // An odometer reading is the column an operator sorts and compares, so it
        // is written as a number with its unit in the cell format — never as the
        // text `format` produced. The `format` callback is dropped in the same
        // move on purpose: with a `type` set it runs only when the value cannot
        // be read as a finite number, and `(null as number).toLocaleString()`
        // throws, which would kill the whole export. `km_stand` is `integer NOT
        // NULL` today (20260302064012), so that path is unreachable — it becomes
        // reachable the moment the column is made nullable.
        { key: 'km_stand',    label: t('werkstatt.odometer'),       width: 14, align: 'right', type: 'kilometres' },
        { key: 'oil_status',  label: t('werkstatt.oilStatus'),      width: 18 },
        { key: 'notes',       label: t('common.notes'),        width: 36 },
        { key: 'repair_notes',label: t('werkstatt.repair'),      width: 36 },
      ],
      rows: filteredChecks.map(c => ({
        check_date:   c.check_date,
        kennzeichen:  c.car?.kennzeichen ?? '',
        status:       c.status,
        km_stand:     c.km_stand,
        oil_status:   c.oil_status ?? '',
        notes:        c.notes,
        repair_notes: c.repair_notes ?? '',
      })),
    });
  }

  const selectStyle: React.CSSProperties = {
    background: 'var(--bg-subtle)', border: '1px solid var(--border)',
    borderRadius: '0.5rem', color: 'var(--text-primary)',
    fontSize: '0.875rem', padding: '0.375rem 0.75rem', outline: 'none',
  };

  /**
   * The failed-read panel and the empty-state panel are one card with two sets
   * of values, not two cards. Written as two the screen would carry five more
   * inline styles and one more literal colour, which the per-file style ratchet
   * fails on; the icon, the heading, the body and the button are chosen here and
   * in the ternaries below instead.
   */
  const EmptyStateIcon = loadFailed !== null ? AlertCircle : Wrench;

  const statusButtons = [
    { key: 'all' as const, label: t('common.all'), activeColor: 'var(--text-primary)', activeBg: 'var(--bg-elevated)' },
    { key: 'negative' as const, label: t('werkstatt.negative'), activeColor: 'var(--danger)', activeBg: 'var(--danger-subtle)' },
    { key: 'repaired' as const, label: t('werkstatt.repaired'), activeColor: 'var(--accent-text)', activeBg: 'var(--accent-subtle)' },
    { key: 'positive' as const, label: t('werkstatt.positive'), activeColor: 'var(--success)', activeBg: 'var(--success-subtle)' },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-3 rounded-xl" style={{ background: 'var(--warning-subtle)' }}>
            <Wrench className="w-7 h-7" style={{ color: 'var(--warning)' }} />
          </div>
          <div>
            <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>{t('nav.werkstatt')}</h1>
            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>{t('werkstatt.subtitle')}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleExport}
            disabled={loadFailed !== null}
            className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-opacity hover:opacity-80"
            style={{
              background: 'var(--success-solid)', color: 'white',
              opacity: loadFailed !== null ? 0.5 : 1,
              cursor: loadFailed !== null ? 'not-allowed' : 'pointer',
            }}
            title={loadFailed !== null ? t('werkstatt.loadFailed') : t('common.exportExcel')}
          >
            <Download className="w-4 h-4" />
            Excel
          </button>
          <button
            onClick={() => { setSelectedCheck(null); setShowModal(true); }}
            className="flex items-center gap-2 px-4 py-2 rounded-lg"
            style={{ background: 'var(--warning-solid)', color: 'white' }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.opacity = '0.85'; }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.opacity = '1'; }}
          >
            <Plus className="w-5 h-5" />
            {t('werkstatt.newCheck')}
          </button>
        </div>
      </div>

      <div className="rounded-xl p-5" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-sm)' }}>
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-3">
            <Calendar className="w-5 h-5" style={{ color: 'var(--text-secondary)' }} />
            <button
              onClick={() => handleMonthChange('prev')}
              className="px-3 py-1 rounded-lg text-sm"
              style={{ border: '1px solid var(--border)', color: 'var(--text-secondary)' }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--bg-muted)'; }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
            >←</button>
            <div className="text-center min-w-[140px] text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
              {selectedMonth.toLocaleDateString('de-DE', { month: 'long', year: 'numeric' })}
            </div>
            <button
              onClick={() => handleMonthChange('next')}
              className="px-3 py-1 rounded-lg text-sm"
              style={{ border: '1px solid var(--border)', color: 'var(--text-secondary)' }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'var(--bg-muted)'; }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
            >→</button>
            <button
              onClick={() => setSelectedMonth(new Date())}
              className="px-3 py-1 rounded-lg text-xs"
              style={{ background: 'var(--bg-muted)', color: 'var(--text-secondary)' }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = 'var(--text-primary)'; }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = 'var(--text-secondary)'; }}
            >{t('common.today')}</button>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>{t('werkstatt.period')}</span>
            <select value={selectedWeek} onChange={(e) => setSelectedWeek(Number(e.target.value))} style={selectStyle}>
              {weeks.map((week) => (
                <option key={week.weekNumber} value={week.weekNumber}>{week.label}</option>
              ))}
            </select>
          </div>

          <div className="flex-1" />

          <div className="flex gap-2">
            {statusButtons.map(btn => (
              <button
                key={btn.key}
                onClick={() => setStatusFilter(btn.key)}
                className="px-4 py-2 rounded-lg text-sm transition-colors"
                style={{
                  background: statusFilter === btn.key ? btn.activeBg : 'var(--bg-subtle)',
                  color: statusFilter === btn.key ? btn.activeColor : 'var(--text-secondary)',
                  border: '1px solid var(--border)',
                  fontWeight: statusFilter === btn.key ? 600 : 400,
                }}
              >{btn.label}</button>
            ))}
          </div>
        </div>
      </div>

      {loading ? (
        <div className="text-center py-12">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 mx-auto" style={{ borderColor: 'var(--warning)' }}></div>
          <p className="mt-4 text-sm" style={{ color: 'var(--text-secondary)' }}>{t('werkstatt.loading')}</p>
        </div>
      ) : loadFailed !== null || filteredChecks.length === 0 ? (
        <div className="rounded-xl p-12 text-center" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-sm)' }}>
          <EmptyStateIcon className="w-16 h-16 mx-auto mb-4" style={{ color: loadFailed !== null ? 'var(--danger)' : 'var(--text-tertiary)' }} />
          <h3 className="text-lg font-medium mb-2" style={{ color: 'var(--text-primary)' }}>
            {loadFailed !== null ? t('werkstatt.loadFailed') : t('werkstatt.none')}
          </h3>
          <p className="mb-4 text-sm" style={{ color: 'var(--text-secondary)' }}>
            {loadFailed !== null
              ? (loadFailed || t('common.error'))
              : statusFilter === 'all'
                ? t('werkstatt.noneWeek')
                : t('werkstatt.noneWithStatus', { status: getStatusConfig(statusFilter).label })}
          </p>
          {/* Not offered while the read failed: "create the first check" says the
              week holds none, which is the one thing this panel cannot claim. */}
          {loadFailed === null && (
            <button
              onClick={() => { setSelectedCheck(null); setShowModal(true); }}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg"
              style={{ background: 'var(--warning-solid)', color: 'white' }}
            >
              <Plus className="w-5 h-5" />
              {t('werkstatt.firstCheck')}
            </button>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredChecks.map((check) => {
            const config = getStatusConfig(check.status);
            return (
              <div
                key={check.id}
                className="rounded-xl p-4"
                style={{ background: config.bg, border: `2px solid ${config.border}`, boxShadow: 'var(--shadow-sm)' }}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.boxShadow = 'var(--shadow-md)'; }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.boxShadow = 'var(--shadow-sm)'; }}
              >
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-center gap-2">
                    {config.icon}
                    <h3 className="font-semibold" style={{ color: 'var(--text-primary)' }}>
                      {check.car?.kennzeichen || t('common.unknown')}
                    </h3>
                  </div>
                  <div className="flex gap-1">
                    <button
                      onClick={() => { setSelectedCheck(check); setShowModal(true); }}
                      className="p-1 rounded"
                      style={{ color: 'var(--text-secondary)' }}
                      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = 'var(--warning)'; }}
                      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = 'var(--text-secondary)'; }}
                    >
                      <Edit2 className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => setCheckToDelete(check)}
                      className="p-1 rounded"
                      style={{ color: 'var(--text-secondary)' }}
                      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = 'var(--danger)'; }}
                      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = 'var(--text-secondary)'; }}
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>

                <div className="space-y-1.5 text-sm">
                  <div>
                    <span className="font-medium" style={{ color: 'var(--text-secondary)' }}>{t('werkstatt.dateLabel')}</span>
                    <span style={{ color: 'var(--text-primary)' }}>{new Date(check.check_date).toLocaleDateString('de-DE')}</span>
                  </div>
                  {check.oil_status && (
                    <div>
                      <span className="font-medium" style={{ color: 'var(--text-secondary)' }}>{t('werkstatt.oilLabel')}</span>
                      <span style={{ color: 'var(--text-primary)' }}>{check.oil_status}</span>
                    </div>
                  )}
                  <div>
                    <span className="font-medium" style={{ color: 'var(--text-secondary)' }}>{t('werkstatt.odometerLabel')}</span>
                    <span style={{ color: 'var(--text-primary)' }}>{check.km_stand.toLocaleString('de-DE')} km</span>
                  </div>
                  <div>
                    <span className="font-medium" style={{ color: 'var(--text-secondary)' }}>{t('werkstatt.notesLabel')}</span>
                    <p style={{ color: 'var(--text-primary)' }}>{check.notes}</p>
                  </div>
                  {check.status === 'repaired' && check.repair_notes && (
                    <div className="mt-2 pt-2 border-t" style={{ borderColor: 'rgba(37,99,235,0.2)' }}>
                      <span className="font-medium" style={{ color: 'var(--accent-text)' }}>{t('werkstatt.repairLabel')}</span>
                      <p style={{ color: 'var(--text-primary)' }}>{check.repair_notes}</p>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {showModal && (
        <WerkstattCheckModal
          check={selectedCheck}
          onClose={() => { setShowModal(false); setSelectedCheck(null); }}
          onSuccess={() => { setShowModal(false); setSelectedCheck(null); loadChecks(); }}
        />
      )}

      {checkToDelete && (
        <ConfirmationModal
          isOpen={!!checkToDelete}
          type="confirm"
          title={t('werkstatt.deleteTitle')}
          message={t('werkstatt.deleteMessage', { plate: checkToDelete.car?.kennzeichen ?? '' })}
          confirmText={t('common.delete')}
          onConfirm={handleDelete}
          onClose={() => setCheckToDelete(null)}
        />
      )}
    </div>
  );
}
