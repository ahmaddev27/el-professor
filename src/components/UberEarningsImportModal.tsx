import { useMemo, useRef, useState } from 'react';
import { AlertTriangle, Download, Loader2 } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useToast } from '../contexts/ToastContext';
import { useTranslation } from '../contexts/LanguageContext';
import type { TranslationKey } from '../i18n';
import { addDaysIso, splitIntoBusinessWeeks, type UnmatchedEarner } from '../../supabase/functions/_shared/uber-earnings-core';
import {
  blockingEarners,
  buildImportRows,
  canConfirmImport,
  findExistingIncome,
  findUnlinked,
  skippedFigures,
  skippedFigureLabel,
  groupByBusinessMonth,
  importRpcArgs,
  readImportAnswer,
  readPullAnswer,
  uberWindowLabel,
  weekNumberOf,
  type DriverLinks,
  type ExistingIncome,
  type DriverPreview,
  type WeekEarnings,
} from '../utils/uberEarningsImport';
import {
  MAX_SELECTABLE_DAYS,
  MAX_SELECTABLE_WEEKS,
  dayRangeExceedsCap,
  dayRangeToDates,
  defaultDayRange,
  defaultWeekRange,
  groupDaysByMonthAndWeek,
  isDaySelected,
  rangeDayCount,
  recentUberDays,
  toggleDay,
  uberDayWindowLabel,
  type DayRange,
  groupWeeksByMonth,
  isWeekSelected,
  normalizePartnerReason,
  rangeExceedsCap,
  rangeForMonth,
  rangeToDates,
  rangeWeekCount,
  recentUberMonths,
  recentUberWeeks,
  toggleWeek,
  type UberMonth,
  type WeekRange,
} from '../utils/uberPeriods';
import {
  Alert,
  Badge,
  Button,
  DataTable,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  formatDate,
  formatEuroCents,
  cn,
  formatNumber,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  type DataTableColumn,
} from './ui';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  /** Called after the rows are written, so the screen reloads its list. */
  onImported: () => void;
}

type PreviewView = 'weekly' | 'monthly';

// The three ways to choose a period. Each keeps its own selection; only the open
// tab's selection is pulled, and the line under the tabs says which.
type PeriodTab = 'daily' | 'weekly' | 'monthly';

type Stage = 'range' | 'pulling' | 'preview' | 'importing';

interface Pulled {
  weeks: WeekEarnings[];
  links: DriverLinks;
  unmatched: UnmatchedEarner[];
  /** Income already in the table around the range, whatever its source. */
  existing: ExistingIncome[];
  /** False when the lookup failed or hit the row cap: "none found" would be a claim. */
  existingComplete: boolean;
}

// PostgREST answers at most this many rows; reaching it means the list may be cut.
const EXISTING_ROW_CAP = 1000;

/**
 * One round trip for the whole range: every income row of the linked drivers
 * from six days before the range (an earlier import can overlap it by its
 * period) to its end. Matching per driver and week happens in the browser.
 */
async function loadExistingIncome(
  from: string, to: string, links: DriverLinks,
): Promise<{ rows: ExistingIncome[]; complete: boolean }> {
  const names = [...new Set(Object.values(links).map(l => l.driverName))];
  if (names.length === 0) return { rows: [], complete: true };
  const { data, error } = await supabase
    .from('income')
    .select('driver_name, date, type, amount, source, source_period_start, source_period_end')
    .gte('date', addDaysIso(from, -6))
    .lte('date', to)
    .in('driver_name', names)
    .limit(EXISTING_ROW_CAP);
  if (error || !data) return { rows: [], complete: false };
  return { rows: data as ExistingIncome[], complete: data.length < EXISTING_ROW_CAP };
}

// Reidey's own stable refusal reasons, named. Anything else is shown with its
// code rather than as a bare failure: a pull that touches money says what it is.
const PARTNER_REASON_KEYS: Record<string, TranslationKey> = {
  no_proxy: 'inc.uber.err.partner.no_proxy',
  uber_session_rejected: 'inc.uber.err.partner.uber_session_rejected',
  too_many_pages: 'inc.uber.err.partner.too_many_pages',
  unreadable_amount: 'inc.uber.err.partner.unreadable_amount',
  range_too_long: 'inc.uber.err.partner.range_too_long',
};

// Reasons the edge function and the database answer with. Values are
// TranslationKeys; an unknown reason falls through to the generic sentence.
const PULL_REASON_KEYS: Record<string, TranslationKey> = {
  not_authorized: 'inc.uber.err.notAuthorized',
  not_connected: 'inc.uber.err.notConnected',
  seal_unreadable: 'inc.uber.err.notConnected',
  token_rejected: 'inc.uber.err.tokenRejected',
  partner_unavailable: 'inc.uber.err.partnerUnavailable',
  partner_malformed: 'inc.uber.err.partnerMalformed',
  invalid_range: 'inc.uber.err.invalidRange',
  range_too_long: 'inc.uber.err.rangeTooLong',
};

const IMPORT_HINT_KEYS: Record<string, TranslationKey> = {
  not_authorized: 'inc.uber.err.notAuthorized',
  platform_session_not_allowed: 'inc.uber.err.platformSession',
  driver_not_linked: 'inc.uber.err.driverNotLinked',
  already_imported: 'inc.uber.err.alreadyImported',
  invalid_request: 'inc.uber.err.invalidRows',
  invalid_period: 'inc.uber.err.invalidRows',
};

/** supabase-js hides the body of a non-2xx answer behind `error.context`. */
async function failureReason(error: unknown): Promise<string | null> {
  const context = (error as { context?: unknown } | null)?.context;
  if (!(context instanceof Response)) return null;
  try {
    const body = (await context.clone().json()) as { reason?: unknown };
    return typeof body?.reason === 'string' ? body.reason : null;
  } catch {
    return null;
  }
}

/** The fixed code beside a refusal's reason (`amount_invalid`, ...), or ''. */
async function failureProblem(error: unknown): Promise<string> {
  const context = (error as { context?: unknown } | null)?.context;
  if (!(context instanceof Response)) return '';
  try {
    const body = (await context.clone().json()) as { problem?: unknown };
    return typeof body?.problem === 'string' ? body.problem : '';
  } catch {
    return '';
  }
}

const MONTH_KEYS: readonly TranslationKey[] = [
  'doc.month.january', 'doc.month.february', 'doc.month.march', 'doc.month.april',
  'doc.month.may', 'doc.month.june', 'doc.month.july', 'doc.month.august',
  'doc.month.september', 'doc.month.october', 'doc.month.november', 'doc.month.december',
];

const monthKeyOf = (m: { year: number; month: number }) => `${m.year}-${m.month}`;

/** Why the chosen period cannot be pulled yet, or null. Said before any request is sent. */
function periodProblemKey(
  tab: PeriodTab, range: WeekRange | null, dayRange: DayRange | null,
): TranslationKey | null {
  if (tab === 'daily') {
    if (!dayRange) return 'inc.uber.period.noDay';
    return dayRangeExceedsCap(dayRange) ? 'inc.uber.period.tooManyDays' : null;
  }
  if (!range) return tab === 'weekly' ? 'inc.uber.period.noWeek' : 'inc.uber.period.noMonth';
  return rangeExceedsCap(range) ? 'inc.uber.period.tooMany' : null;
}

/** 'Di.' / 'Tue': display only, from the ISO date itself so no time zone moves it. */
function weekdayShort(iso: string, language: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Intl.DateTimeFormat(language === 'en' ? 'en-GB' : 'de-DE', { weekday: 'short', timeZone: 'UTC' })
    .format(new Date(Date.UTC(y!, m! - 1, d!)));
}

function UberEarningsImportModal({ isOpen, onClose, onImported }: Props) {
  const { t, tPlural, language } = useTranslation();
  const { success } = useToast();
  const now = useMemo(() => new Date(), []);
  const weekGroups = useMemo(() => groupWeeksByMonth(recentUberWeeks(now)), [now]);
  const monthOptions = useMemo(() => recentUberMonths(now), [now]);
  const dayGroups = useMemo(() => groupDaysByMonthAndWeek(recentUberDays(now)), [now]);
  // Daily is the default (owner, 15.10.2026): the day is the finest unit Uber reports.
  const [periodTab, setPeriodTab] = useState<PeriodTab>('daily');
  const [dayRange, setDayRange] = useState<DayRange | null>(() => defaultDayRange(now));
  const [weekRange, setWeekRange] = useState<WeekRange | null>(() => defaultWeekRange(now));
  const [monthKey, setMonthKey] = useState<string | null>(null);
  const [stage, setStage] = useState<Stage>('range');
  const [pulled, setPulled] = useState<Pulled | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [view, setView] = useState<PreviewView>('weekly');
  // The operator's choice to replace an earlier Uber import. Never carried over: a new pull asks again.
  const [replaceChosen, setReplaceChosen] = useState(false);
  // A pull still in flight when the dialog closes must not open a preview later.
  const generation = useRef(0);

  const monthRange = useMemo(() => {
    const month = monthOptions.find(m => monthKeyOf(m) === monthKey);
    return month ? rangeForMonth(month) : null;
  }, [monthOptions, monthKey]);
  const range = periodTab === 'weekly' ? weekRange : monthRange;
  // A daily pick is a shorter range, not a different protocol: the pull below
  // cuts it at business weeks all the same.
  const { from, to } = periodTab === 'daily'
    ? (dayRange ? dayRangeToDates(dayRange) : { from: '', to: '' })
    : (range ? rangeToDates(range) : { from: '', to: '' });
  const split = splitIntoBusinessWeeks(from, to);
  const weekCount = rangeWeekCount(range);
  const dayCount = rangeDayCount(dayRange);
  const chosen = periodTab === 'daily'
    ? dayRange !== null && !dayRangeExceedsCap(dayRange)
    : range !== null && !rangeExceedsCap(range);
  const canPull = chosen && split.ok;
  const periodProblem = periodProblemKey(periodTab, range, dayRange);

  const rows = useMemo(() => (pulled ? buildImportRows(pulled.weeks) : []), [pulled]);
  const unlinked = useMemo(() => (pulled ? findUnlinked(pulled.weeks, pulled.links) : []), [pulled]);
  const skipped = useMemo(() => (pulled ? skippedFigures(pulled.weeks) : []), [pulled]);
  // Both causes stop the import and both are named: an earner Reidey cannot
  // place, and a Reidey driver nobody here has linked.
  const existingByWeek = useMemo(
    () => (pulled ? findExistingIncome(pulled.weeks, pulled.links, pulled.existing) : []),
    [pulled],
  );
  const manualWeeks = existingByWeek.filter(e => e.manualCount > 0);
  const importedWeeks = existingByWeek.filter(e => e.importedCount > 0);
  const blocking = useMemo(() => blockingEarners(unlinked, pulled?.unmatched ?? []), [unlinked, pulled]);
  // The weekly view is read OUT of the monthly grouping, so the two can only
  // ever show the same per-week figures.
  const months = useMemo(() => (pulled ? groupByBusinessMonth(pulled.weeks, pulled.links) : []), [pulled]);
  const weekly = useMemo(() => months.flatMap(m => m.weeks), [months]);

  const close = () => {
    generation.current += 1;
    setStage('range');
    setPulled(null);
    setProblem(null);
    setReplaceChosen(false);
    onClose();
  };

  const pull = async () => {
    const mine = ++generation.current;
    setStage('pulling');
    setProblem(null);
    setView('weekly');
    setReplaceChosen(false);
    try {
      const { data, error } = await supabase.functions.invoke('uber-earnings-pull', { body: { from, to } });
      if (mine !== generation.current) return;
      const body = data as
        { reason?: string; partner_reason?: string; partner_detail?: string; problem?: string } | null;
      const reason = error ? await failureReason(error) : body?.reason ?? null;
      const problemCode = error ? await failureProblem(error) : body?.problem ?? '';
      const read = error || reason ? null : readPullAnswer(data);
      if (!read) {
        const partnerReason = reason === 'partner_refused' ? normalizePartnerReason(body?.partner_reason ?? '') : '';
        // A reason we have no sentence for is shown with Reidey's own — `uber_error`
        // is its catch-all for "Uber answered with something other than 2xx, 401
        // or 403", so a 400 and a 429 arrive under one word and need different
        // fixes. The status is in that sentence, and showing the code alone left
        // nothing to act on.
        const named = partnerReason !== '' && PARTNER_REASON_KEYS[partnerReason] !== undefined;
        const detail = !named ? (body?.partner_detail ?? '').trim() : '';
        setProblem(
          reason === 'partner_refused'
            ? named
              ? t(PARTNER_REASON_KEYS[partnerReason]!)
              : detail !== ''
                ? t('inc.uber.err.partner.detail', { reason: partnerReason, detail })
                : t('inc.uber.err.partner.generic', { reason: partnerReason })
            : `${t(reason && PULL_REASON_KEYS[reason] ? PULL_REASON_KEYS[reason] : 'inc.uber.err.generic')}${
              /^[a-z][a-z0-9_]{0,59}$/.test(problemCode) ? ` (${problemCode})` : ''}`,
        );
        setStage('range');
        return;
      }
      const existing = await loadExistingIncome(from, to, read.links);
      if (mine !== generation.current) return;
      setPulled({ ...read, existing: existing.rows, existingComplete: existing.complete });
      setStage('preview');
    } catch {
      if (mine !== generation.current) return;
      setProblem(t('inc.uber.err.generic'));
      setStage('range');
    }
  };

  const confirm = async () => {
    setStage('importing');
    setProblem(null);
    const { data, error } = await supabase.rpc('income_import_uber', importRpcArgs(rows, importedWeeks.length, replaceChosen));
    if (error) {
      const hint = (error as { hint?: string }).hint ?? '';
      // A day inside an already imported period is the likeliest refusal of a daily import.
      const key = hint === 'already_imported' && periodTab === 'daily'
        ? 'inc.uber.err.alreadyImportedDaily'
        : IMPORT_HINT_KEYS[hint] ?? 'inc.uber.err.generic';
      const detail = hint === 'driver_not_linked' ? (error as { details?: string }).details : undefined;
      setProblem(detail ? `${t(key)} (${detail})` : t(key));
      setStage('preview');
      return;
    }
    const result = readImportAnswer(data, rows.length);
    const replaced = result.deleted > 0
      ? ` ${tPlural({ one: 'inc.uber.replace.done.one', other: 'inc.uber.replace.done.other' }, result.deleted)}`
      : '';
    success(
      t('inc.uber.doneTitle'),
      t('inc.uber.doneBody', { rows: String(result.inserted), drivers: String(result.drivers) }) + replaced,
    );
    onImported();
    close();
  };

  // ── Presentation ──────────────────────────────────────────────────────────

  const money = (cents: number) => <span className="tabular-nums">{formatEuroCents(cents)}</span>;

  const columns: DataTableColumn<DriverPreview>[] = [
    {
      id: 'driver',
      header: t('common.driver'),
      value: row => row.ourName ?? row.uberName,
      cell: row => (
        <div className="grid gap-0.5">
          {row.ourName ? (
            <span className="font-medium text-fg">{row.ourName}</span>
          ) : (
            <span className="inline-flex flex-wrap items-center gap-2">
              <span className="font-medium text-fg">{row.uberName}</span>
              <Badge tone="critical">{t('inc.uber.unlinked')}</Badge>
            </span>
          )}
          {row.ourName && row.ourName !== row.uberName && (
            <span className="text-xs text-fg-subtle">{t('inc.uber.uberName', { name: row.uberName })}</span>
          )}
        </div>
      ),
    },
    { id: 'fare', header: t('inc.nettoFahrpreis'), kind: 'currency', value: row => row.fareCents, cell: row => money(row.fareCents) },
    { id: 'promotion', header: t('inc.typeAktionen'), kind: 'currency', value: row => row.promotionCents, cell: row => money(row.promotionCents), hideBelow: 'md' },
    { id: 'tips', header: t('inc.typeTrinkgeld'), kind: 'currency', value: row => row.tipsCents, cell: row => money(row.tipsCents), hideBelow: 'md' },
    { id: 'cash', header: t('inc.typeBargeld'), kind: 'currency', value: row => row.cashCents, cell: row => money(row.cashCents), hideBelow: 'sm' },
    {
      id: 'trips',
      header: t('inc.tripCount'),
      kind: 'number',
      value: row => row.trips,
      cell: row => (row.trips === null ? '—' : formatNumber(row.trips)),
      hideBelow: 'sm',
    },
    {
      id: 'difference',
      header: t('inc.uber.difference'),
      kind: 'currency',
      value: row => row.differenceCents,
      cell: row =>
        row.hasDifference ? (
          <span className="inline-flex items-center justify-end gap-1 font-medium tabular-nums text-critical">
            <AlertTriangle aria-hidden className="size-3.5" />
            {formatEuroCents(row.differenceCents)}
            <span className="sr-only"> {t('inc.uber.differenceFlag')}</span>
          </span>
        ) : (
          money(0)
        ),
    },
  ];

  const existingVars = (e: { driverName: string; segment: WeekEarnings['segment'] }, count: number) => ({
    name: e.driverName,
    week: t('inc.weekLabel', { week: weekNumberOf(e.segment) }),
    from: formatDate(e.segment.from),
    to: formatDate(e.segment.to),
    count: String(count),
  });
  const weekHeading = (segment: WeekEarnings['segment'], week: number) =>
    `${t('inc.weekLabel', { week })} ${uberWindowLabel(segment)}`;
  const monthName = (month: number) => t(MONTH_KEYS[month - 1]!);

  const busy = stage === 'pulling' || stage === 'importing';
  const rowClass = (selected: boolean) => cn(
    'flex min-h-10 cursor-pointer items-center gap-3 rounded-control border px-3 py-2 text-sm [@media(pointer:coarse)]:min-h-11',
    selected ? 'border-brand bg-brand-soft' : 'border-border bg-raised',
  );
  const inputClass = 'size-4 shrink-0 accent-brand [@media(pointer:coarse)]:size-5';

  const dayPicker = (
    <div className="grid grid-cols-1 gap-4">
      <p className="text-xs text-fg-subtle">{t('inc.uber.period.dayHint')}</p>
      <p className="text-xs text-fg-subtle">{t('inc.uber.period.dayWrites')}</p>
      <div role="group" aria-label={t('inc.uber.period.dayListLabel')} className="grid max-h-80 grid-cols-1 gap-4 overflow-y-auto pr-1">
        {dayGroups.map(month => (
          <section key={`${month.year}-${month.month}`} className="grid grid-cols-1 gap-3">
            <h3 className="text-sm font-semibold text-fg">{`${monthName(month.month)} ${month.year}`}</h3>
            {month.weeks.map(week => (
              <div key={week.monday} className="grid grid-cols-1 gap-2">
                <h4 className="text-xs font-medium text-fg-muted">{t('inc.weekLabel', { week: week.weekNumber })}</h4>
                {week.days.map(day => {
                  const selected = isDaySelected(dayRange, day.date);
                  return (
                    <label key={day.date} className={rowClass(selected)}>
                      <input
                        type="checkbox"
                        className={inputClass}
                        checked={selected}
                        disabled={busy}
                        onChange={() => setDayRange(toggleDay(dayRange, day.date))}
                      />
                      <span className="font-medium text-fg tabular-nums">
                        {`${weekdayShort(day.date, language)} ${formatDate(day.date)}`}
                      </span>
                      <span className="min-w-0 text-fg-muted tabular-nums">{uberDayWindowLabel(day)}</span>
                      {day.running && <Badge tone="brand">{t('inc.uber.period.running')}</Badge>}
                    </label>
                  );
                })}
              </div>
            ))}
          </section>
        ))}
      </div>
    </div>
  );

  const weekPicker = (
    <div className="grid grid-cols-1 gap-4">
      <p className="text-xs text-fg-subtle">{t('inc.uber.period.weekHint')}</p>
      <div role="group" aria-label={t('inc.uber.period.weekListLabel')} className="grid max-h-80 grid-cols-1 gap-4 overflow-y-auto pr-1">
        {weekGroups.map(group => (
          <section key={`${group.year}-${group.month}`} className="grid grid-cols-1 gap-2">
            <h3 className="text-sm font-semibold text-fg">{`${monthName(group.month)} ${group.year}`}</h3>
            {group.weeks.map(week => {
              const selected = isWeekSelected(weekRange, week.segment.monday);
              return (
                <label key={week.segment.monday} className={rowClass(selected)}>
                  <input
                    type="checkbox"
                    className={inputClass}
                    checked={selected}
                    disabled={busy}
                    onChange={() => setWeekRange(toggleWeek(weekRange, week.segment.monday))}
                  />
                  <span className="font-medium text-fg">{t('inc.weekLabel', { week: week.weekNumber })}</span>
                  <span className="min-w-0 text-fg-muted tabular-nums">{uberWindowLabel(week.segment)}</span>
                  {week.running && <Badge tone="brand">{t('inc.uber.period.running')}</Badge>}
                </label>
              );
            })}
          </section>
        ))}
      </div>
    </div>
  );

  const monthTitle = (m: UberMonth) => tPlural(
    { one: 'inc.uber.monthHeading.one', other: 'inc.uber.monthHeading.other' },
    m.weeks.length,
    { month: monthName(m.month), year: String(m.year) },
  );
  const monthPicker = (
    <div className="grid grid-cols-1 gap-4">
      <p className="text-xs text-fg-subtle">{t('inc.uber.period.monthHint')}</p>
      <div role="radiogroup" aria-label={t('inc.uber.period.monthListLabel')} className="grid max-h-80 grid-cols-1 gap-2 overflow-y-auto pr-1">
        {monthOptions.map(m => {
          const selected = monthKey === monthKeyOf(m);
          return (
            <label key={monthKeyOf(m)} className={rowClass(selected)}>
              <input
                type="radio"
                name="uber-month"
                className={inputClass}
                checked={selected}
                disabled={busy}
                onChange={() => setMonthKey(monthKeyOf(m))}
              />
              <span className="font-medium text-fg">{monthTitle(m)}</span>
              {m.completeCount < m.weeks.length && (
                <Badge tone="caution">
                  {t('inc.uber.period.monthProgress', { done: String(m.completeCount), total: String(m.weeks.length) })}
                </Badge>
              )}
            </label>
          );
        })}
      </div>
    </div>
  );

  const previewTable = (rows: DriverPreview[], caption: string) => {
    const sum = (pick: (row: DriverPreview) => number) => rows.reduce((acc, row) => acc + pick(row), 0);
    return (
      <DataTable
        caption={caption}
        columns={columns}
        rows={rows}
        getRowId={row => row.externalDriverId}
        density="compact"
        totals={{
          driver: t('inc.sum'),
          fare: money(sum(r => r.fareCents)),
          promotion: money(sum(r => r.promotionCents)),
          tips: money(sum(r => r.tipsCents)),
          cash: money(sum(r => r.cashCents)),
          difference: money(sum(r => r.differenceCents)),
        }}
      />
    );
  };
  const canConfirm = stage === 'preview' && canConfirmImport({
    rowCount: rows.length,
    blockingCount: blocking.length,
    importedWeekCount: importedWeeks.length,
    replaceChosen,
  });

  return (
    <Dialog open={isOpen} onOpenChange={open => { if (!open && !busy) close(); }}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>{t('inc.uber.title')}</DialogTitle>
          <DialogDescription>
            {stage === 'preview' || stage === 'importing' ? t('inc.uber.previewIntro') : t('inc.uber.rangeIntro')}
          </DialogDescription>
        </DialogHeader>

        {problem && <Alert tone="critical" title={t('inc.uber.errorTitle')}>{problem}</Alert>}

        {stage === 'preview' && skipped.length > 0 && (
          <Alert tone="critical" title={t('import.earnings.skippedTitle')}>
            {t('import.earnings.skippedBody', {
              items: skipped.map(f => skippedFigureLabel(f, formatEuroCents)).join('; '),
            })}
          </Alert>
        )}

        {(stage === 'range' || stage === 'pulling') && (
          <div className="grid grid-cols-1 gap-4">
            <Tabs value={periodTab} onValueChange={value => setPeriodTab(value as PeriodTab)}>
              <TabsList aria-label={t('inc.uber.period.tabsLabel')}>
                <TabsTrigger value="daily">{t('inc.uber.tab.daily')}</TabsTrigger>
                <TabsTrigger value="weekly">{t('inc.uber.tab.weekly')}</TabsTrigger>
                <TabsTrigger value="monthly">{t('inc.uber.tab.monthly')}</TabsTrigger>
              </TabsList>
              <TabsContent value="daily" className="pt-4">{dayPicker}</TabsContent>
              <TabsContent value="weekly" className="pt-4">{weekPicker}</TabsContent>
              <TabsContent value="monthly" className="pt-4">{monthPicker}</TabsContent>
            </Tabs>
            {periodProblem ? (
              <p role="alert" className="text-sm text-critical">
                {t(periodProblem, {
                  max: String(periodTab === 'daily' ? MAX_SELECTABLE_DAYS : MAX_SELECTABLE_WEEKS),
                  count: String(periodTab === 'daily' ? dayCount : weekCount),
                })}
              </p>
            ) : (
              <p className="text-sm text-fg-muted">
                {periodTab === 'daily'
                  ? tPlural({ one: 'inc.uber.daysCount.one', other: 'inc.uber.daysCount.other' }, dayCount)
                  : tPlural({ one: 'inc.uber.weeksCount.one', other: 'inc.uber.weeksCount.other' }, weekCount)}
              </p>
            )}
          </div>
        )}

        {(stage === 'preview' || stage === 'importing') && pulled && (
          <div className="grid grid-cols-1 gap-4">
            {blocking.length > 0 && (
              <Alert tone="critical" title={t('inc.uber.blockedTitle')}>
                <p>{t('inc.uber.blockedBody')}</p>
                <ul className="mt-2 list-disc pl-5">
                  {blocking.map((b, i) => (
                    <li key={`${b.kind}-${b.externalDriverId ?? b.name}-${i}`}>
                      {b.kind === 'unmatched_at_reidey'
                        ? t('inc.uber.blockedUnmatched', { name: b.name })
                        : t('inc.uber.blockedUnlinked', { name: b.name, id: b.externalDriverId ?? '' })}
                    </li>
                  ))}
                </ul>
              </Alert>
            )}
            {importedWeeks.length > 0 && (
              <Alert tone="caution" title={t('inc.uber.replace.title')}>
                <p>{t('inc.uber.replace.body')}</p>
                <ul className="mt-2 list-disc pl-5">
                  {importedWeeks.map(e => (
                    <li key={`i-${e.driverName}-${e.segment.from}`}>
                      {t('inc.uber.importedItem', existingVars(e, e.importedCount))}
                    </li>
                  ))}
                </ul>
                <label className={cn(rowClass(replaceChosen), 'mt-3')}>
                  <input
                    type="checkbox"
                    className={inputClass}
                    checked={replaceChosen}
                    disabled={busy}
                    onChange={event => setReplaceChosen(event.target.checked)}
                  />
                  <span className="font-medium text-fg">{t('inc.uber.replace.choice')}</span>
                </label>
              </Alert>
            )}
            {manualWeeks.length > 0 && (
              <Alert tone="caution" title={t('inc.uber.manualTitle')}>
                <p>{t('inc.uber.manualBody')}</p>
                <ul className="mt-2 list-disc pl-5">
                  {manualWeeks.map(e => (
                    <li key={`m-${e.driverName}-${e.segment.from}`}>
                      {t('inc.uber.manualItem', existingVars(e, e.manualCount))}
                    </li>
                  ))}
                </ul>
              </Alert>
            )}
            {!pulled.existingComplete && (
              <Alert tone="caution">{t('inc.uber.existingUnchecked')}</Alert>
            )}
            {blocking.length === 0 && rows.length === 0 && (
              <Alert tone="caution">{t('inc.uber.nothingToImport')}</Alert>
            )}

            <Tabs value={view} onValueChange={value => setView(value as PreviewView)}>
              <TabsList aria-label={t('inc.uber.tabsLabel')}>
                <TabsTrigger value="weekly">{t('inc.uber.tab.weekly')}</TabsTrigger>
                <TabsTrigger value="monthly">{t('inc.uber.tab.monthly')}</TabsTrigger>
              </TabsList>
              <TabsContent value="weekly" className="grid grid-cols-1 gap-6 pt-4">
                {weekly.map(w => (
                  <section key={w.segment.from} className="grid grid-cols-1 gap-2">
                    <h3 className="text-sm font-semibold text-fg">{weekHeading(w.segment, w.weekNumber)}</h3>
                    {previewTable(w.drivers, weekHeading(w.segment, w.weekNumber))}
                  </section>
                ))}
              </TabsContent>
              <TabsContent value="monthly" className="grid grid-cols-1 gap-6 pt-4">
                {months.map(m => {
                  const heading = tPlural(
                    { one: 'inc.uber.monthHeading.one', other: 'inc.uber.monthHeading.other' },
                    m.weeks.length,
                    { month: monthName(m.month), year: String(m.year) },
                  );
                  return (
                    <section key={`${m.year}-${m.month}`} className="grid grid-cols-1 gap-2">
                      <h3 className="text-sm font-semibold text-fg">{heading}</h3>
                      <p className="text-xs text-fg-subtle">
                        {t('inc.uber.monthWeeks', {
                          weeks: m.weeks.map(w => weekHeading(w.segment, w.weekNumber)).join(' · '),
                        })}
                      </p>
                      {previewTable(m.drivers, heading)}
                    </section>
                  );
                })}
              </TabsContent>
            </Tabs>
          </div>
        )}

        <DialogFooter>
          {(stage === 'range' || stage === 'pulling') && (
            <>
              <Button variant="secondary" onClick={close} disabled={busy}>{t('common.cancel')}</Button>
              <Button onClick={pull} disabled={!canPull || busy}>
                {stage === 'pulling' ? <Loader2 aria-hidden className="animate-spin" /> : <Download aria-hidden />}
                {stage === 'pulling' ? t('inc.uber.loading') : t('inc.uber.load')}
              </Button>
            </>
          )}
          {(stage === 'preview' || stage === 'importing') && (
            <>
              <Button variant="secondary" onClick={() => { setStage('range'); setPulled(null); setProblem(null); }} disabled={busy}>
                {t('inc.uber.changeRange')}
              </Button>
              <Button onClick={confirm} disabled={!canConfirm || busy}>
                {stage === 'importing' && <Loader2 aria-hidden className="animate-spin" />}
                {stage === 'importing' ? t('inc.uber.importing') : t('inc.uber.confirm', { count: String(rows.length) })}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default UberEarningsImportModal;
