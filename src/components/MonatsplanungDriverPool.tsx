import React, { useEffect, useMemo, useState } from 'react';
import { Users, UserCheck, AlertTriangle, Clock, CalendarDays, Target, Wallet, StickyNote, Filter } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useTranslation } from '../contexts/LanguageContext';
import type { TranslationKey } from '../i18n';

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
  target_monthly_hours: number | null;
  max_monthly_hours: number | null;
  planning_target_salary: number | null;
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
    target_monthly_hours: get<number>('target_monthly_hours'),
    max_monthly_hours: get<number>('max_monthly_hours'),
    planning_target_salary:
      get<number>('planning_target_salary') ??
      get<number>('wish_salary') ??
      null,
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
  if (d.employment_type !== 'company_owner' && d.target_monthly_hours == null) out.push('mp.pool.missingMonthlyTarget');
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

  const planningEnabledDrivers = useMemo(
    () => drivers.filter(d => d.planning_enabled !== false && d.status !== 'inactive'),
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

  return (
    <div className="space-y-6">
      <div className="rounded-xl p-5" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}>
        <div className="flex items-start justify-between gap-4 mb-4">
          <div>
            <h2 className="text-base font-semibold flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
              <Users size={16} /> {t('mp.pool.title')}
            </h2>
            <p className="text-xs mt-1" style={{ color: 'var(--text-tertiary)' }}>
              {t('mp.pool.subtitle')}
            </p>
          </div>
        </div>

        {/* Quick actions */}
        <div className="flex flex-wrap items-center gap-2 mb-4">
          <ChipBtn onClick={selectAll}>{t('mp.pool.selectAll')}</ChipBtn>
          <ChipBtn onClick={selectNone}>{t('mp.pool.selectNone')}</ChipBtn>
          <ChipBtn onClick={selectFahrtenbuchOnly} icon={<Filter size={12} />}>
            {t('mp.pool.onlyWithTrips', { count: matchedDriverIds.size })}
          </ChipBtn>
          <ChipBtn onClick={selectRegularOnly} icon={<Filter size={12} />}>
            {t('mp.pool.onlyRegular')}
          </ChipBtn>
        </div>

        {/* Summary */}
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-4 mb-4">
          <Stat label={t('mp.pool.statTotal')} value={total} />
          <Stat label={t('mp.pool.statSelected')} value={selectedCount} tone="primary" />
          <Stat label={t('mp.pool.statNotSelected')} value={notSelected} />
          <Stat label={t('mp.pool.inFahrtenbuch')} value={inFahrtenbuch} />
          <Stat label={t('mp.pool.statSelectedRegular')} value={selectedRegular} />
          <Stat label={t('mp.pool.statNoWorkTime')} value={missingWindow} tone={missingWindow > 0 ? 'warning' : undefined} />
          <Stat label={t('mp.pool.statNoWorkDays')} value={missingDays} tone={missingDays > 0 ? 'warning' : undefined} />
        </div>

        {loading && (
          <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>{t('mp.pool.loading')}</div>
        )}
        {error && (
          <div
            className="px-3 py-2 rounded-lg text-sm flex items-center gap-2"
            style={{ background: 'var(--bg-danger-subtle, #fef2f2)', color: 'var(--danger, #b91c1c)' }}
          >
            <AlertTriangle size={15} /> {t('mp.pool.loadError', { error })}
          </div>
        )}

        {!loading && !error && drivers.length === 0 && (
          <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            {t('mp.pool.noDrivers')}
          </div>
        )}

        {drivers.length > 0 && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {drivers.map(d => {
              const selected = selectedIds.has(d.id);
              const matched = matchedDriverIds.has(d.id);
              const missing = driverMissing(d);
              return (
                <div
                  key={d.id}
                  className="rounded-lg p-3 transition-colors"
                  style={{
                    border: `1px solid ${selected ? 'var(--primary)' : 'var(--border)'}`,
                    background: selected ? 'var(--bg-primary-subtle, rgba(59,130,246,0.06))' : 'var(--bg-subtle)',
                  }}
                >
                  <label className="flex items-start gap-3 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={selected}
                      onChange={() => toggle(d.id)}
                      className="mt-1"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold text-sm" style={{ color: 'var(--text-primary)' }}>
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
                            <UserCheck size={10} /> {t('mp.pool.inFahrtenbuch')}
                          </Tag>
                        )}
                        {d.planning_enabled === false && <Tag tone="warning">{t('mp.pool.planningDisabled')}</Tag>}
                      </div>

                      <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-x-3 gap-y-1 text-xs" style={{ color: 'var(--text-secondary)' }}>
                        <Field icon={<Clock size={11} />} label={t('mp.pool.fieldWorkTime')}>
                          {d.is_full_day_available
                            ? t('mp.pool.allDay')
                            : `${formatTime(d.work_window_start)}–${formatTime(d.work_window_end)}`}
                        </Field>
                        <Field icon={<CalendarDays size={11} />} label={t('mp.pool.fieldDays')}>
                          {formatWeekdays(d.allowed_weekdays, t)}
                        </Field>
                        <Field icon={<Target size={11} />} label={t('mp.pool.fieldMaxPerDay')}>
                          {d.max_daily_hours != null ? `${d.max_daily_hours}h` : '—'}
                        </Field>
                        <Field icon={<Target size={11} />} label={t('mp.pool.fieldMonthlyTarget')}>
                          {d.target_monthly_hours != null ? `${d.target_monthly_hours}h` : '—'}
                          {d.max_monthly_hours != null && ` ${t('mp.pool.maxSuffix', { hours: d.max_monthly_hours })}`}
                        </Field>
                        {(d.planning_min_salary != null || d.planning_max_salary != null) && (
                          <Field icon={<Wallet size={11} />} label={t('mp.pool.fieldSalaryRange')}>
                            {d.planning_min_salary != null ? `${d.planning_min_salary.toFixed(2)} €` : '—'}
                            {' – '}
                            {d.planning_max_salary != null ? `${d.planning_max_salary.toFixed(2)} €` : '—'}
                          </Field>
                        )}
                        {d.notes && d.notes.trim() && (
                          <Field icon={<StickyNote size={11} />} label={t('common.notes')} full>
                            {d.notes}
                          </Field>
                        )}
                      </div>

                      {missing.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1">
                          {missing.map(m => (
                            <span
                              key={m}
                              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold"
                              style={{ background: 'rgba(234,179,8,0.12)', color: '#a16207' }}
                            >
                              <AlertTriangle size={10} /> {t(m)}
                            </span>
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
      </div>
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
    <button
      onClick={onClick}
      type="button"
      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold transition-colors"
      style={{
        background: 'var(--bg-subtle)',
        color: 'var(--text-primary)',
        border: '1px solid var(--border)',
      }}
    >
      {icon}
      {children}
    </button>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: 'primary' | 'warning';
}) {
  const color =
    tone === 'primary' ? 'var(--primary)' :
    tone === 'warning' ? '#a16207' :
    'var(--text-primary)';
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider font-semibold mb-1" style={{ color: 'var(--text-tertiary)' }}>
        {label}
      </div>
      <div className="text-xl font-bold" style={{ color }}>{value}</div>
    </div>
  );
}

function Tag({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone?: 'primary' | 'warning' | 'owner';
}) {
  const bg =
    tone === 'primary' ? 'rgba(59,130,246,0.12)' :
    tone === 'warning' ? 'rgba(234,179,8,0.15)' :
    tone === 'owner' ? 'rgba(16,185,129,0.12)' :
    'var(--bg-muted)';
  const color =
    tone === 'primary' ? 'var(--primary)' :
    tone === 'warning' ? '#a16207' :
    tone === 'owner' ? '#047857' :
    'var(--text-tertiary)';
  return (
    <span
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold"
      style={{ background: bg, color }}
    >
      {children}
    </span>
  );
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
      <span className="inline-flex items-center gap-1 mr-1" style={{ color: 'var(--text-tertiary)' }}>
        {icon}
        {label}:
      </span>
      <span style={{ color: 'var(--text-primary)' }}>{children}</span>
    </div>
  );
}
