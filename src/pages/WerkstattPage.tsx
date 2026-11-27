import { useState, useEffect, useRef } from 'react';
import { Plus, Wrench, Calendar, AlertCircle, CheckCircle, CreditCard as Edit2, Trash2, Download } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useToast } from '../contexts/ToastContext';
import { getWeeksOfMonth, getWeekNumberForDate, type WeekOfMonth } from '../utils/weekCalculations';
import WerkstattCheckModal from '../components/WerkstattCheckModal';
import { format } from 'date-fns';
import { useColumnPickerExport } from '../contexts/ExportPickerContext';
import { useSuperAdmin } from '../contexts/SuperAdminContext';
import { useTranslation } from '../contexts/LanguageContext';
import { useCompanyScope } from '../hooks/useCompanyScope';
import { Alert, Badge, Button, ConfirmDialog, EmptyState, NativeSelect, PageHeader, cn } from '../components/ui';
import { deleteChecked } from '../lib/writeOutcome';

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
  // `werkstatt_checks` is gated by the Werkstatt page right; a refused UPDATE or
  // DELETE is silent (lib/writeOutcome.ts), so the buttons ask the same question.
  const mayEdit = useCompanyScope().can('werkstatt', 'edit');

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
      const checkId = checkToDelete.id;
      const outcome = await deleteChecked(supabase, 'werkstatt_checks', q => q.eq('id', checkId));
      if (outcome === 'refused') {
        showToast('error', t('common.writeRefused'));
        return;
      }
      if (outcome === 'gone') showToast('error', t('common.writeAlreadyGone'));
      else showToast('success', t('werkstatt.deleted'));
      loadChecks();
    } catch (error: any) {
      showToast('error', t('werkstatt.deleteFailedReason', { error: error.message }));
    } finally {
      setCheckToDelete(null);
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

  // ── Presentation (phase 5) ────────────────────────────────────────────────
  // Everything above is the screen's logic and is unchanged, except that
  // `getStatusConfig` moved below: it held the words and the colours in one
  // object, and the colours are the look. Everything below only draws.

  const getStatusConfig = (status: string) => {
    switch (status) {
      case 'positive': return {
        icon: <CheckCircle aria-hidden className="size-5 text-positive" />,
        card: 'border-positive/30 bg-positive-soft', tone: 'positive' as const, label: t('werkstatt.positive'),
      };
      case 'negative': return {
        icon: <AlertCircle aria-hidden className="size-5 text-critical" />,
        card: 'border-critical/30 bg-critical-soft', tone: 'critical' as const, label: t('werkstatt.negative'),
      };
      case 'repaired': return {
        icon: <Wrench aria-hidden className="size-5 text-info" />,
        card: 'border-info/30 bg-info-soft', tone: 'info' as const, label: t('werkstatt.repaired'),
      };
      default: return { icon: null, card: 'border-line bg-sunken', tone: 'neutral' as const, label: status };
    }
  };

  const statusButtons = [
    { key: 'all' as const, label: t('common.all'), active: 'bg-sunken text-fg' },
    { key: 'negative' as const, label: t('werkstatt.negative'), active: 'bg-critical-soft text-critical' },
    { key: 'repaired' as const, label: t('werkstatt.repaired'), active: 'bg-info-soft text-info' },
    { key: 'positive' as const, label: t('werkstatt.positive'), active: 'bg-positive-soft text-positive' },
  ];

  // `mr-1`: the dictionary's labels end in a colon with no space, and the value
  // follows inline, so without it a card read „Datum:17.9.2026“.
  const labelClass = 'mr-1 font-medium text-fg-muted';

  return (
    <div className="space-y-6 font-ui">
      <PageHeader
        className="pb-0"
        title={t('nav.werkstatt')}
        description={t('werkstatt.subtitle')}
        actions={(
          <>
            <Button
              variant="secondary"
              onClick={handleExport}
              disabled={loadFailed !== null}
              title={loadFailed !== null ? t('werkstatt.loadFailed') : t('common.exportExcel')}
            >
              <Download aria-hidden />
              Excel
            </Button>
            <Button onClick={() => { setSelectedCheck(null); setShowModal(true); }}>
              <Plus aria-hidden />
              {t('werkstatt.newCheck')}
            </Button>
          </>
        )}
      />

      <div className="glass-card rounded-surface p-5">
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex flex-wrap items-center gap-3">
            <Calendar aria-hidden className="size-5 text-fg-muted" />
            <button
              type="button"
              onClick={() => handleMonthChange('prev')}
              className={cn(
                'inline-flex h-[30px] items-center justify-center rounded-tight border border-edge bg-raised px-3 text-sm text-fg shadow-raised transition-colors hover:bg-raised/[1.4] [@media(pointer:coarse)]:h-10 [@media(pointer:coarse)]:min-w-10',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus',
              )}
            >←</button>
            <div className="min-w-[140px] whitespace-nowrap text-center text-sm font-semibold text-fg">
              {selectedMonth.toLocaleDateString('de-DE', { month: 'long', year: 'numeric' })}
            </div>
            <button
              type="button"
              onClick={() => handleMonthChange('next')}
              className={cn(
                'inline-flex h-[30px] items-center justify-center rounded-tight border border-edge bg-raised px-3 text-sm text-fg shadow-raised transition-colors hover:bg-raised/[1.4] [@media(pointer:coarse)]:h-10 [@media(pointer:coarse)]:min-w-10',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus',
              )}
            >→</button>
            <Button variant="secondary" size="sm" className="[@media(pointer:coarse)]:min-w-10" onClick={() => setSelectedMonth(new Date())}>{t('common.today')}</Button>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-fg-muted">{t('werkstatt.period')}</span>
            <NativeSelect containerClassName="w-auto" className="h-9" value={selectedWeek} onChange={(e) => setSelectedWeek(Number(e.target.value))}>
              {weeks.map((week) => (
                <option key={week.weekNumber} value={week.weekNumber}>{week.label}</option>
              ))}
            </NativeSelect>
          </div>

          <div className="flex-1" />

          {/* Two by two on a phone: four in a wrapping row left „Positiv“ alone on a line. */}
          <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:flex-wrap">
            {statusButtons.map(btn => (
              <button
                key={btn.key}
                type="button"
                aria-pressed={statusFilter === btn.key}
                onClick={() => setStatusFilter(btn.key)}
                className={cn(
                  'rounded-control border border-line px-4 py-2 text-sm transition-colors [@media(pointer:coarse)]:min-h-11',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus',
                  statusFilter === btn.key ? cn('font-semibold', btn.active) : 'bg-field font-normal text-fg-muted hover:bg-sunken',
                )}
              >{btn.label}</button>
            ))}
          </div>
        </div>
      </div>

      {loading ? (
        <div className="py-12 text-center">
          <div className="mx-auto h-12 w-12 rounded-full border-b-2 border-brand motion-safe:animate-spin" />
          <p className="mt-4 text-sm text-fg-muted">{t('werkstatt.loading')}</p>
        </div>
      ) : loadFailed !== null ? (
        <Alert tone="critical" title={t('werkstatt.loadFailed')}>
          {loadFailed || t('common.error')}
        </Alert>
      ) : filteredChecks.length === 0 ? (
        <div className="glass-card rounded-surface p-6">
          <EmptyState
            icon={Wrench}
            title={t('werkstatt.none')}
            description={statusFilter === 'all'
              ? t('werkstatt.noneWeek')
              : t('werkstatt.noneWithStatus', { status: getStatusConfig(statusFilter).label })}
            action={(
              <Button onClick={() => { setSelectedCheck(null); setShowModal(true); }}>
                <Plus aria-hidden />
                {t('werkstatt.firstCheck')}
              </Button>
            )}
          />
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {filteredChecks.map((check) => {
            const config = getStatusConfig(check.status);
            return (
              <div
                key={check.id}
                className={cn('rounded-surface border-2 p-4 shadow-raised transition-shadow hover:shadow-elev-md', config.card)}
              >
                <div className="mb-3 flex items-start justify-between">
                  <div className="flex flex-wrap items-center gap-2">
                    {config.icon}
                    <h3 className="font-semibold text-fg">
                      {check.car?.kennzeichen || t('common.unknown')}
                    </h3>
                    <Badge tone={config.tone}>{config.label}</Badge>
                  </div>
                  {mayEdit && <div className="flex gap-1">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t('common.edit')}
                      className="hover:text-caution"
                      onClick={() => { setSelectedCheck(check); setShowModal(true); }}
                    >
                      <Edit2 aria-hidden />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t('common.delete')}
                      className="hover:text-critical"
                      onClick={() => setCheckToDelete(check)}
                    >
                      <Trash2 aria-hidden />
                    </Button>
                  </div>}
                </div>

                <div className="space-y-1.5 text-sm">
                  <div>
                    <span className={labelClass}>{t('werkstatt.dateLabel')}</span>
                    <span className="whitespace-nowrap tabular-nums text-fg">{new Date(check.check_date).toLocaleDateString('de-DE')}</span>
                  </div>
                  {check.oil_status && (
                    <div>
                      <span className={labelClass}>{t('werkstatt.oilLabel')}</span>
                      <span className="text-fg">{check.oil_status}</span>
                    </div>
                  )}
                  <div>
                    <span className={labelClass}>{t('werkstatt.odometerLabel')}</span>
                    <span className="whitespace-nowrap tabular-nums text-fg">{check.km_stand.toLocaleString('de-DE')} km</span>
                  </div>
                  <div>
                    <span className={labelClass}>{t('werkstatt.notesLabel')}</span>
                    <p className="text-fg">{check.notes}</p>
                  </div>
                  {check.status === 'repaired' && check.repair_notes && (
                    <div className="mt-2 border-t border-info/20 pt-2">
                      <span className="font-medium text-info">{t('werkstatt.repairLabel')}</span>
                      <p className="text-fg">{check.repair_notes}</p>
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
        <ConfirmDialog
          open={!!checkToDelete}
          title={t('werkstatt.deleteTitle')}
          description={t('werkstatt.deleteMessage', { plate: checkToDelete.car?.kennzeichen ?? '' })}
          confirmLabel={t('common.delete')}
          onConfirm={handleDelete}
          onClose={() => setCheckToDelete(null)}
        />
      )}
    </div>
  );
}
