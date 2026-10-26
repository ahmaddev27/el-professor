import React, { useEffect, useMemo, useState } from 'react';
import { Users, UserCheck, AlertTriangle, Clock, CalendarDays, Target, Wallet, StickyNote, Filter } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useTranslation } from '../contexts/LanguageContext';
import type { TranslationKey } from '../i18n';
import { ACTIVE_DRIVER_STATUS, selectableDrivers } from '../utils/driverStatus';
import { Alert, Badge, Button, Card, cn, formatEuro } from './ui';

export interface PlanningDriver {
  id: string;
  name: string;
  driver_usage_type: 'regular' | 'coverage_only' | null;
  planning_enabled: boolean;
  status: 'active' | 'inactive' | null;
  work_window_start: string | null;
  work_window_end: string | null;
  allowed_weekdays: number[] | null;
  max_daily_hours: number | null;
  planning_target_salary: number | null;
  /**
   * Read for the LEGACY pipeline only (`monatsplanungPhase3`), which still
   * treats both as constraints. The monthly plan works from salaries since
   * 01.10.2026 and reads neither — and this screen no longer displays them or
   * warns when they are empty, because §5 forbids `target_monthly_hours` as a
   * displayed figure and asking for a field nothing reads is worse than silence.
   */
  target_monthly_hours: number | null;
  max_monthly_hours: number | null;
  planning_min_salary: number | null;
  planning_max_salary: number | null;
  planning_hourly_rate: number | null;
  notes: string | null;
  is_full_day_available: boolean;
  employment_type: 'employee' | 'company_owner';
}

const WEEKDAY_CODE_TO_ISO: Record<string, number> = {
  mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 7,
};

// Map a raw drivers row (select '*') into the safe PlanningDriver shape.
// Falls back across old/new column names so missing optional fields never crash.
function mapDriverRow(d: Record<string, unknown>): PlanningDriver {
  const get = <T,>(k: string): T | null => (d[k] === undefined || d[k] === null ? null : (d[k] as T));

  // Working time window — prefer new `planned_shift_*`, fall back to `work_window_*`.
  const winStart = (get<string>('planned_shift_start_time') ?? get<string>('work_window_start')) || null;
  const winEnd = (get<string>('planned_shift_end_time') ?? get<string>('work_window_end')) || null;

  // Weekdays — prefer integer `allowed_weekdays`, fall back to `planned_working_days` codes.
  let weekdays: number[] | null = null;
  const awd = d['allowed_weekdays'];
  if (Array.isArray(awd) && awd.length > 0) {
    weekdays = awd.map(Number).filter(n => !isNaN(n));
  } else {
    const pwd = d['planned_working_days'];
    if (Array.isArray(pwd) && pwd.length > 0) {
      weekdays = pwd
        .map(x => WEEKDAY_CODE_TO_ISO[String(x).toLowerCase()])
        .filter((n): n is number => typeof n === 'number');
    }
  }

  const usage = get<string>('driver_usage_type');
  const planningEnabledRaw = d['planning_enabled'];

  return {
    id: String(d['id'] ?? ''),
    name: String(d['name'] ?? ''),
    driver_usage_type: usage === 'regular' || usage === 'coverage_only' ? usage : null,
    planning_enabled: planningEnabledRaw === undefined ? true : !!planningEnabledRaw,
    status: (get<string>('status') as PlanningDriver['status']) ?? 'active',
    work_window_start: winStart,
    work_window_end: winEnd,
    allowed_weekdays: weekdays,
    max_daily_hours:
      get<number>('max_daily_hours') ??
      get<number>('max_daily_work_hours') ??
      null,
    planning_target_salary:
      get<number>('planning_target_salary') ??
      get<number>('wish_salary') ??
      null,
    target_monthly_hours: get<number>('target_monthly_hours'),
    max_monthly_hours: get<number>('max_monthly_hours'),
    planning_min_salary:
      get<number>('planning_min_salary') ??
      get<number>('planning_target_salary') ??
      null,
    planning_max_salary:
      get<number>('planning_max_salary') ??
      get<number>('planning_target_salary') ??
      null,
    planning_hourly_rate: get<number>('planning_hourly_rate') ?? null,
    notes: get<string>('notes') ?? get<string>('planning_notes') ?? null,
    is_full_day_available: d['is_full_day_available'] === true,
    employment_type: d['employment_type'] === 'company_owner' ? 'company_owner' : 'employee',
  };
}

interface DriverPoolProps {
  companyId: string;
  originalDriverNames: string[];
  originalDriverIds: string[];
  selectedIds: Set<string>;
  onSelectedChange: (ids: Set<string>) => void;
  onDriversLoaded?: (drivers: PlanningDriver[]) => void;
}

// Indexed by ISO weekday (1 = Monday); slot 0 is an unused placeholder. The
// entries are TranslationKeys because this list is module-level and t() is a
// hook value — every consumer resolves it.
const WEEKDAY_LABELS: (TranslationKey | null)[] = [
  null,
  'fleet.weekday.mon',
  'fleet.weekday.tue',
  'fleet.weekday.wed',
  'fleet.weekday.thu',
  'fleet.weekday.fri',
  'fleet.weekday.sat',
  'fleet.weekday.sun',
];

function normName(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

function formatWeekdays(days: number[] | null, t: (key: TranslationKey) => string): string {
  if (!days || days.length === 0) return '—';
  const sorted = [...days].sort();
  return sorted.map(d => {
    const key = WEEKDAY_LABELS[d];
    return key ? t(key) : '?';
  }).join(', ');
}

function formatTime(time: string | null): string {
  if (!time) return '—';
  const m = /^(\d{1,2}):(\d{2})/.exec(time);
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : time;
}

// Returns TranslationKeys; the badge that renders them resolves each with t().
function driverMissing(d: PlanningDriver): TranslationKey[] {
  const out: TranslationKey[] = [];
  if (!d.is_full_day_available && (!d.work_window_start || !d.work_window_end)) out.push('mp.pool.missingWorkWindow');
  if (!d.allowed_weekdays || d.allowed_weekdays.length === 0) out.push('mp.pool.missingWorkDays');
  if (d.max_daily_hours == null) out.push('mp.pool.missingMaxDaily');
  // No `Monatsziel` warning: the plan works from salaries (owner's decision,
  // 01.10.2026), and §5 forbids `target_monthly_hours` as a target, a
  // constraint, a sort key AND a displayed figure. Asking the operator to fill a
  // field nothing reads is worse than not asking.
  if (d.employment_type !== 'company_owner'
      && (d.planning_min_salary == null || d.planning_max_salary == null || d.planning_hourly_rate == null)) {
    out.push('mp.pool.missingSalaryRange');
  }
  return out;
}

export default function MonatsplanungDriverPool({
  companyId,
  originalDriverNames,
  originalDriverIds,
  selectedIds,
  onSelectedChange,
  onDriversLoaded,
}: DriverPoolProps) {
  const { t } = useTranslation();
  const [drivers, setDrivers] = useState<PlanningDriver[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [initialized, setInitialized] = useState(false);

  // Load drivers from the company.
  //
  // Active drivers only, and the filter is in the QUERY rather than in the
  // render, because this list has four consumers and the deactivated leaked
  // through three of them: the card grid below drew every driver, `selectAll`
  // and `selectRegularOnly` selected from the unfiltered array, and
  // `onDriversLoaded` handed it to the parent — where `MonthlyPlanPage` turns it
  // into the engine's `PlanDriverInput[]` and `CompanyPlannerPage` into the
  // Stundennachweis preview's `selectedDrivers`. Only the *default* selection
  // (`planningEnabledDrivers`) ever excluded them, so one press of
  // "Alle auswählen" put a driver who had left into the month's plan. This is
  // the list the owner's instruction of 25.10.2026 names first.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const { data, error: err } = await supabase
          .from('drivers')
          .select('*')
          .eq('company_id', companyId)
          .eq('status', ACTIVE_DRIVER_STATUS)
          .order('name', { ascending: true });
        if (err) {
          console.error('[Phase2] drivers query error:', err);
          throw err;
        }
        if (cancelled) return;
        const rows = (data as Record<string, unknown>[]) ?? [];
        const mapped = rows.map(mapDriverRow);
        setDrivers(mapped);
        onDriversLoaded?.(mapped);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : (typeof e === 'object' && e ? JSON.stringify(e) : String(e));
        console.error('[Phase2] Fehler beim Laden der Fahrer:', e);
        if (!cancelled) setError(msg);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [companyId]);

  // Match Fahrtenbuch original drivers against company drivers by id or normalized name.
  const matchedDriverIds = useMemo(() => {
    const idSet = new Set(originalDriverIds.filter(Boolean));
    const nameSet = new Set(originalDriverNames.map(normName).filter(Boolean));
    const matched = new Set<string>();
    for (const d of drivers) {
      if (idSet.has(d.id)) {
        matched.add(d.id);
        continue;
      }
      if (nameSet.has(normName(d.name))) {
        matched.add(d.id);
      }
    }
    return matched;
  }, [drivers, originalDriverIds, originalDriverNames]);

  // `selectableDrivers` is the second wall, not a leftover: the query above
  // already excludes the deactivated, and keeping the term here means the
  // default selection stays correct if that filter is ever lost in a rebase.
  const planningEnabledDrivers = useMemo(
    () => selectableDrivers(drivers).filter(d => d.planning_enabled !== false),
    [drivers],
  );

  // Default selection once drivers are loaded.
  useEffect(() => {
    if (initialized || drivers.length === 0) return;
    let initial: Set<string>;
    if (matchedDriverIds.size > 0) {
      initial = new Set(matchedDriverIds);
    } else {
      initial = new Set(planningEnabledDrivers.map(d => d.id));
    }
    onSelectedChange(initial);
    setInitialized(true);
  }, [initialized, drivers, matchedDriverIds, planningEnabledDrivers, onSelectedChange]);

  const toggle = (id: string) => {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onSelectedChange(next);
  };

  const selectAll = () => onSelectedChange(new Set(drivers.map(d => d.id)));
  const selectNone = () => onSelectedChange(new Set());
  const selectFahrtenbuchOnly = () => onSelectedChange(new Set(matchedDriverIds));
  const selectRegularOnly = () => onSelectedChange(new Set(drivers.filter(d => d.driver_usage_type === 'regular').map(d => d.id)));

  const total = drivers.length;
  const selectedCount = selectedIds.size;
  const notSelected = total - selectedCount;
  const inFahrtenbuch = matchedDriverIds.size;
  const selectedRegular = drivers.filter(d => selectedIds.has(d.id) && d.driver_usage_type === 'regular').length;
  const missingWindow = drivers.filter(d => selectedIds.has(d.id) && !d.is_full_day_available && (!d.work_window_start || !d.work_window_end)).length;
  const missingDays = drivers.filter(d => selectedIds.has(d.id) && (!d.allowed_weekdays || d.allowed_weekdays.length === 0)).length;

  // ── Presentation (phase 5) ────────────────────────────────────────────────
  // Everything above is the pool's logic and is unchanged: which drivers load,
  // which are matched to the Fahrtenbuch, the default selection, the quick
  // selections and every count. Below only draws them. The one change in what
  // a figure says: a salary range is written through utils/money.ts
  // ("2.100,00 €"), where toFixed(2) wrote it with a US decimal point.
  const euro = (amount: number) => (Number.isFinite(amount) ? formatEuro(amount) : String(amount));

  return (
    <div className="space-y-6">
      <Card className="p-5 font-ui">
        <div className="mb-4">
          <h2 className="flex items-center gap-2 text-[15px] font-semibold text-fg">
            <Users aria-hidden className="size-4 text-fg-muted" /> {t('mp.pool.title')}
          </h2>
          <p className="mt-1 text-[13px] text-fg-muted">
            {t('mp.pool.subtitle')}
          </p>
        </div>

        {/* Quick actions */}
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <ChipBtn onClick={selectAll}>{t('mp.pool.selectAll')}</ChipBtn>
          <ChipBtn onClick={selectNone}>{t('mp.pool.selectNone')}</ChipBtn>
          <ChipBtn onClick={selectFahrtenbuchOnly} icon={<Filter aria-hidden />}>
            {t('mp.pool.onlyWithTrips', { count: matchedDriverIds.size })}
          </ChipBtn>
          <ChipBtn onClick={selectRegularOnly} icon={<Filter aria-hidden />}>
            {t('mp.pool.onlyRegular')}
          </ChipBtn>
        </div>

        {/* Summary. A read that failed counts nothing, so it shows no counts. */}
        {!error && (
          <dl className="mb-4 grid grid-cols-2 gap-x-4 gap-y-3 border-y border-line py-4 sm:grid-cols-4 lg:grid-cols-7">
            <Stat label={t('mp.pool.statTotal')} value={total} />
            <Stat label={t('mp.pool.statSelected')} value={selectedCount} tone="primary" />
            <Stat label={t('mp.pool.statNotSelected')} value={notSelected} />
            <Stat label={t('mp.pool.inFahrtenbuch')} value={inFahrtenbuch} />
            <Stat label={t('mp.pool.statSelectedRegular')} value={selectedRegular} />
            <Stat label={t('mp.pool.statNoWorkTime')} value={missingWindow} tone={missingWindow > 0 ? 'warning' : undefined} />
            <Stat label={t('mp.pool.statNoWorkDays')} value={missingDays} tone={missingDays > 0 ? 'warning' : undefined} />
          </dl>
        )}

        {loading && (
          <p className="text-sm text-fg-muted">{t('mp.pool.loading')}</p>
        )}
        {error && (
          <Alert tone="critical">{t('mp.pool.loadError', { error })}</Alert>
        )}

        {!loading && !error && drivers.length === 0 && (
          <p className="text-sm text-fg-muted">
            {t('mp.pool.noDrivers')}
          </p>
        )}

        {drivers.length > 0 && (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {drivers.map(d => {
              const selected = selectedIds.has(d.id);
              const matched = matchedDriverIds.has(d.id);
              const missing = driverMissing(d);
              return (
                <div
                  key={d.id}
                  className={cn(
                    'rounded-control border p-3 transition-colors',
                    selected ? 'border-brand/60 bg-brand-soft' : 'border-line bg-raised',
                  )}
                >
                  <label className="flex cursor-pointer items-start gap-3">
                    <input
                      type="checkbox"
                      checked={selected}
                      onChange={() => toggle(d.id)}
                      className="mt-0.5 size-4 shrink-0 accent-brand [@media(pointer:coarse)]:size-5"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="mr-0.5 text-sm font-semibold text-fg">
                          {d.name}
                        </span>
                        {d.driver_usage_type && (
                          <Tag>
                            {d.driver_usage_type === 'regular' ? t('mp.pool.typeRegular') : t('mp.pool.typeCoverage')}
                          </Tag>
                        )}
                        {d.employment_type === 'company_owner' && (
                          <Tag tone="owner">{t('mp.pool.owner')}</Tag>
                        )}
                        {matched && (
                          <Tag tone="primary">
                            <UserCheck aria-hidden /> {t('mp.pool.inFahrtenbuch')}
                          </Tag>
                        )}
                        {d.planning_enabled === false && <Tag tone="warning">{t('mp.pool.planningDisabled')}</Tag>}
                      </div>

                      <div className="mt-2 grid grid-cols-1 gap-x-3 gap-y-1 text-xs sm:grid-cols-2">
                        <Field icon={<Clock aria-hidden />} label={t('mp.pool.fieldWorkTime')}>
                          {d.is_full_day_available
                            ? t('mp.pool.allDay')
                            : `${formatTime(d.work_window_start)}–${formatTime(d.work_window_end)}`}
                        </Field>
                        <Field icon={<CalendarDays aria-hidden />} label={t('mp.pool.fieldDays')}>
                          {formatWeekdays(d.allowed_weekdays, t)}
                        </Field>
                        <Field icon={<Target aria-hidden />} label={t('mp.pool.fieldMaxPerDay')}>
                          {d.max_daily_hours != null ? `${d.max_daily_hours}h` : '—'}
                        </Field>
                        {(d.planning_min_salary != null || d.planning_max_salary != null) && (
                          <Field icon={<Wallet aria-hidden />} label={t('mp.pool.fieldSalaryRange')}>
                            {d.planning_min_salary != null ? euro(d.planning_min_salary) : '—'}
                            {' – '}
                            {d.planning_max_salary != null ? euro(d.planning_max_salary) : '—'}
                          </Field>
                        )}
                        {d.notes && d.notes.trim() && (
                          <Field icon={<StickyNote aria-hidden />} label={t('common.notes')} full>
                            {d.notes}
                          </Field>
                        )}
                      </div>

                      {missing.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1">
                          {missing.map(m => (
                            <Badge key={m} tone="caution">
                              <AlertTriangle aria-hidden /> {t(m)}
                            </Badge>
                          ))}
                        </div>
                      )}
                    </div>
                  </label>
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}

function ChipBtn({
  children,
  onClick,
  icon,
}: {
  children: React.ReactNode;
  onClick: () => void;
  icon?: React.ReactNode;
}) {
  return (
    <Button variant="secondary" size="sm" onClick={onClick}>
      {icon}
      {children}
    </Button>
  );
}

// Tones keep their old names, so each call site above reads as before.
const STAT_TONE = { primary: 'text-brand-text', warning: 'text-caution' } as const;

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: 'primary' | 'warning';
}) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium text-fg-muted">
        {label}
      </dt>
      <dd className={cn('mt-0.5 text-xl font-semibold tabular-nums', tone ? STAT_TONE[tone] : 'text-fg')}>{value}</dd>
    </div>
  );
}

// Green is kept for a status; the owner is a role, so the tag stays neutral.
const TAG_TONE = { primary: 'brand', warning: 'caution', owner: 'neutral' } as const;

function Tag({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone?: 'primary' | 'warning' | 'owner';
}) {
  return <Badge tone={tone ? TAG_TONE[tone] : 'neutral'}>{children}</Badge>;
}

function Field({
  icon,
  label,
  children,
  full,
}: {
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
  full?: boolean;
}) {
  return (
    <div className={full ? 'sm:col-span-2' : ''}>
      <span className="mr-1 inline-flex items-center gap-1 text-fg-muted [&_svg]:size-3 [&_svg]:shrink-0">
        {icon}
        {label}:
      </span>
      <span className="tabular-nums text-fg">{children}</span>
    </div>
  );
}
