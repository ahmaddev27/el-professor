import { useCallback, useEffect, useMemo, useState } from 'react';
import { FlaskConical } from 'lucide-react';
import { Alert, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Field, Input, KpiCard, PageHeader, formatEuro } from '../components/ui';
import { SimulatedBadge } from '../components/simulatedRides/SimulatedBadge';
import { useCompanySettings } from '../contexts/CompanySettingsContext';
import { useSuperAdmin } from '../contexts/SuperAdminContext';
import { useToast } from '../contexts/ToastContext';
import { useTranslation } from '../contexts/LanguageContext';
import { useCompanyScope } from '../hooks/useCompanyScope';
import { useFahrtenbuch } from '../hooks/useFahrtenbuch';
import { supabase } from '../lib/supabase';
import { loadCompanyDrivers, loadSettings } from '../lib/tripAnalysisClient';
import type { CompanyDriver } from '../lib/tripAnalysisView';
import type { TranslationKey } from '../i18n';
import { PoolError, buildAddressPool, readCachedPool, writeCachedPool, type AddressPool } from '../utils/simulatedRides/addressPool';
import {
  addDays, figuresOf, generateFromFigures, mondayOf, mondaysOfMonth, weekKey, type Finding, type FindingCode, type FiguresResult, type IncomeRow,
} from '../utils/simulatedRides/figures';
import { validateRides } from '../utils/simulatedRides/generator';
import { prepareSimulatedImport, type PreparedSimulatedImport } from '../utils/simulatedRides/importPath';
import { rideDate, ridesToRows } from '../utils/simulatedRides/sheet';
import type { GeoPoint } from '../utils/simulatedRides/types';

/**
 * Fahrten simulieren: rides that EXPLAIN the figures already in the books.
 *
 * For each driver and business week that has income, the generator makes rides
 * whose fares add up to exactly the recorded umsatz, bargeld and trinkgeld. It
 * writes no income and invents no total; a week without figures gets no rides,
 * and a week whose records contradict each other, or that already has trips, is
 * refused and listed. The rides are written to an .xlsx and taken through the
 * ordinary import, with the import row marked `is_simulated`. The database
 * copies that marker onto every ride and refuses to change it. The times,
 * addresses and routes are invented, so the marker stays: this screen has no
 * control that leaves it out and must not get one.
 */
type Phase = 'idle' | 'pool' | 'generating' | 'ready' | 'importing' | 'done';

interface CarOption { id: string; plate: string }

interface Result {
  generated: FiguresResult;
  prepared: PreparedSimulatedImport;
  poolRequests: number;
  poolCached: boolean;
  booksBefore: number;
}

const FINDING_KEYS: Record<FindingCode, TranslationKey> = {
  unknown_driver: 'simrides.finding.unknown_driver',
  negative_amount: 'simrides.finding.negative_amount',
  fractional_cent: 'simrides.finding.fractional_cent',
  cash_without_revenue: 'simrides.finding.cash_without_revenue',
  cash_exceeds_revenue: 'simrides.finding.cash_exceeds_revenue',
  tip_without_revenue: 'simrides.finding.tip_without_revenue',
  revenue_too_small: 'simrides.finding.revenue_too_small',
  real_trips_exist: 'simrides.finding.real_trips_exist',
  cannot_explain: 'simrides.finding.cannot_explain',
};

const POOL_ERROR_KEYS = {
  city_not_found: 'simrides.error.pool.cityNotFound',
  too_few_addresses: 'simrides.error.pool.tooFew',
  request_failed: 'simrides.error.pool.requestFailed',
} as const;

const PAGE = 1000;
const checkboxClass = 'mt-1 size-4 shrink-0 cursor-pointer accent-brand disabled:cursor-not-allowed';
const nextTick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));
const fetchJson = (url: string) => fetch(url, { headers: { Accept: 'application/json' } });

function defaultMonthKey(): string {
  const now = new Date();
  now.setMonth(now.getMonth() - 1);
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function toggled(list: readonly string[], id: string): string[] {
  return list.includes(id) ? list.filter(x => x !== id) : [...list, id];
}

function savedBase(row: Awaited<ReturnType<typeof loadSettings>>): GeoPoint | null {
  const lat = Number(row?.base_latitude);
  const lon = Number(row?.base_longitude);
  return row?.base_latitude != null && row?.base_longitude != null && Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
}

/** The books of the weeks that belong to the month, and the trips those weeks already hold. */
async function readBooks(companyId: string, year: number, month: number): Promise<{ income: IncomeRow[]; occupied: Set<string> }> {
  const mondays = mondaysOfMonth(year, month);
  if (mondays.length === 0) return { income: [], occupied: new Set() };
  const from = mondays[0];
  const to = addDays(mondays[mondays.length - 1], 6);
  const income: IncomeRow[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await supabase.from('income').select('driver_name, type, date, amount')
      .eq('company_id', companyId).gte('date', from).lte('date', to).order('id').range(offset, offset + PAGE - 1);
    if (error) throw new Error(error.message);
    income.push(...((data ?? []) as IncomeRow[]));
    if ((data ?? []).length < PAGE) break;
  }
  const occupied = new Set<string>();
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await supabase.from('fahrtenbuch_trips').select('original_driver_name, trip_date')
      .eq('company_id', companyId).gte('trip_date', from).lte('trip_date', to).order('id').range(offset, offset + PAGE - 1);
    if (error) throw new Error(error.message);
    for (const row of (data ?? []) as { original_driver_name: string; trip_date: string }[]) {
      occupied.add(weekKey(row.original_driver_name, mondayOf(row.trip_date)));
    }
    if ((data ?? []).length < PAGE) break;
  }
  return { income, occupied };
}

const sumCents = (rows: readonly IncomeRow[]): number => rows.reduce((s, r) => s + Math.round(Number(r.amount) * 100), 0);

export default function SimulatedRidesPage() {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const { effectiveCompanyId: companyId } = useSuperAdmin();
  const { settings } = useCompanySettings();
  const scope = useCompanyScope();
  const { createImport } = useFahrtenbuch();
  const canWrite = scope.can('documents', 'edit') && !scope.readOnly;

  const [monthKey, setMonthKey] = useState(defaultMonthKey);
  const [city, setCity] = useState('');
  const [seed, setSeed] = useState(() => Math.floor(Math.random() * 2_000_000_000));
  const [cars, setCars] = useState<CarOption[]>([]);
  const [drivers, setDrivers] = useState<CompanyDriver[]>([]);
  const [carIds, setCarIds] = useState<string[]>([]);
  const [base, setBase] = useState<GeoPoint | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);

  useEffect(() => {
    if (settings?.city) setCity(current => current || settings.city || '');
  }, [settings?.city]);

  useEffect(() => {
    if (!companyId) return;
    let live = true;
    setLoadFailed(false);
    void (async () => {
      try {
        const [carRows, driverRows, settingsRow] = await Promise.all([
          supabase.from('cars').select('id, kennzeichen').eq('company_id', companyId).order('kennzeichen'),
          loadCompanyDrivers(companyId),
          loadSettings(companyId),
        ]);
        if (carRows.error) throw new Error(carRows.error.message);
        if (!live) return;
        const carList = ((carRows.data ?? []) as { id: string; kennzeichen: string }[]).map(c => ({ id: c.id, plate: c.kennzeichen }));
        setCars(carList);
        setCarIds(carList.map(c => c.id));
        setDrivers(driverRows);
        setBase(savedBase(settingsRow));
      } catch (err) {
        console.error('Fahrten simulieren: loading the company failed', err);
        if (live) setLoadFailed(true);
      }
    })();
    return () => { live = false; };
  }, [companyId]);

  const period = useMemo(() => {
    const match = /^(\d{4})-(\d{2})$/.exec(monthKey);
    return match ? { year: Number(match[1]), month: Number(match[2]) } : null;
  }, [monthKey]);

  const ensurePool = useCallback(async (): Promise<{ pool: AddressPool; cached: boolean }> => {
    const storage = typeof window === 'undefined' ? null : window.localStorage;
    const cached = readCachedPool(city, storage);
    if (cached) return { pool: cached, cached: true };
    const pool = await buildAddressPool(city.trim(), { fetchFn: fetchJson, onProgress: (done, total) => setProgress({ done, total }) });
    writeCachedPool(pool, storage);
    return { pool, cached: false };
  }, [city]);

  const failureText = (err: unknown): string => {
    if (err instanceof PoolError) return t(POOL_ERROR_KEYS[err.reason], { city: city.trim() });
    return err instanceof Error ? err.message : t('simrides.error.generic');
  };

  const generate = async () => {
    if (!period || !companyId) return;
    setError(null);
    setResult(null);
    setPhase('pool');
    try {
      const books = await readBooks(companyId, period.year, period.month);
      const { pool, cached } = await ensurePool();
      const origin = base ?? pool.center;
      setPhase('generating');
      await nextTick();
      const vehicles = cars.filter(c => carIds.includes(c.id)).map(c => ({ plate: c.plate, type: 'Mietwagen' }));
      const generated = generateFromFigures({
        ...period, base: origin, pool: pool.addresses, vehicles, drivers: drivers.map(d => ({ name: d.name })),
        income: books.income, occupied: books.occupied, seed,
      });
      if (generated.month.rides.length === 0) throw new Error(t('simrides.error.noRides'));
      assertSound(generated, origin);
      const prepared = await prepareSimulatedImport({
        ...period, seed, rows: ridesToRows(generated.month.rides),
        drivers: drivers.map(d => ({ id: d.id, name: d.name })), cars,
      });
      setResult({ generated, prepared, poolRequests: cached ? 0 : pool.requests, poolCached: cached, booksBefore: sumCents(books.income) });
      setPhase('ready');
    } catch (err) {
      setError(failureText(err));
      setPhase('idle');
    }
  };

  /** Nothing is offered for import unless the rides pass every rule and add up to the books. */
  const assertSound = (generated: FiguresResult, origin: GeoPoint) => {
    if (validateRides(generated.month, origin).length > 0) throw new Error(t('simrides.error.validation'));
    const read = figuresOf(generated.month.rides, rideDate);
    const exact = generated.explained.every(f => {
      const got = read.get(weekKey(f.driver, f.weekMonday));
      return got !== undefined && got.umsatz === f.umsatz && got.bargeld === f.bargeld && got.trinkgeld === f.trinkgeld;
    });
    if (!exact) throw new Error(t('simrides.error.mismatch'));
  };

  const runImport = async () => {
    if (!result || !period || !companyId) return;
    setPhase('importing');
    setError(null);
    try {
      const { prepared } = result;
      await createImport({
        ...period, fileName: prepared.file.fileName, trips: prepared.trips, fileSha256: prepared.fileSha256,
        sourceSheetName: prepared.sheetName, sourceColumns: prepared.headers, xlsxBytes: prepared.file.bytes, isSimulated: true,
      });
      const after = await readBooks(companyId, period.year, period.month);
      if (sumCents(after.income) !== result.booksBefore) throw new Error(t('simrides.error.booksMoved'));
      showToast('success', t('simrides.done.title'));
      setPhase('done');
    } catch (err) {
      setError(failureText(err));
      setPhase('ready');
    }
  };

  const busy = phase === 'pool' || phase === 'generating' || phase === 'importing';
  const ready = canWrite && !loadFailed && Boolean(period) && city.trim() !== '' && carIds.length > 0 && drivers.length > 0 && !busy;

  return (
    <div className="grid grid-cols-1 gap-5 font-ui">
      <PageHeader title={t('simrides.title')} description={t('simrides.subtitle')} />
      <Alert tone="caution" icon={FlaskConical} role="note" title={t('simrides.banner.title')}>{t('simrides.banner.body')}</Alert>
      {loadFailed ? <Alert tone="critical" title={t('simrides.error.load')} /> : null}
      {!canWrite ? <Alert tone="neutral">{t('simrides.error.readOnly')}</Alert> : null}

      <Card>
        <CardHeader>
          <CardTitle>{t('simrides.form.title')}</CardTitle>
          <CardDescription>{t('simrides.form.figures')}</CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label={t('simrides.field.month')}>
              <Input type="month" value={monthKey} onChange={e => setMonthKey(e.target.value)} disabled={busy} />
            </Field>
            <Field label={t('simrides.field.city')} hint={base ? t('simrides.field.cityHintBase') : t('simrides.field.cityHint')}>
              <Input value={city} onChange={e => setCity(e.target.value)} disabled={busy} />
            </Field>
          </div>
          <fieldset className="m-0 grid min-w-0 grid-cols-1 gap-2 border-0 p-0" disabled={busy}>
            <legend className="mb-1 text-[13px] font-medium text-fg-muted">{t('simrides.field.cars')}</legend>
            {cars.length === 0 ? <p className="text-sm text-fg-subtle">{t('simrides.noCars')}</p> : null}
            {cars.map(car => (
              <label key={car.id} className="flex cursor-pointer items-start gap-3 text-sm text-fg">
                <input type="checkbox" className={checkboxClass} checked={carIds.includes(car.id)} onChange={() => setCarIds(list => toggled(list, car.id))} />
                <span>{car.plate}</span>
              </label>
            ))}
          </fieldset>
          <details className="text-sm text-fg-muted">
            <summary className="cursor-pointer">{t('simrides.field.advanced')}</summary>
            <div className="mt-3 max-w-xs">
              <Field label={t('simrides.field.seed')} hint={t('simrides.field.seedHint')}>
                <Input type="number" min={0} value={seed} onChange={e => setSeed(Math.max(0, Math.floor(Number(e.target.value)) || 0))} disabled={busy} />
              </Field>
            </div>
          </details>
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={generate} disabled={!ready} loading={phase === 'pool' || phase === 'generating'}>
              <FlaskConical aria-hidden /> {t('simrides.action.generate')}
            </Button>
            {phase === 'pool' ? <p role="status" className="text-sm text-fg-muted">{t('simrides.progress.pool', progress)}</p> : null}
            {phase === 'generating' ? <p role="status" className="text-sm text-fg-muted">{t('simrides.progress.generating')}</p> : null}
          </div>
          {error ? <Alert tone="critical">{error}</Alert> : null}
        </CardContent>
      </Card>

      {result ? <ResultCard result={result} phase={phase} onImport={runImport} /> : null}
    </div>
  );
}

function FindingsList({ findings }: { findings: readonly Finding[] }) {
  const { t } = useTranslation();
  if (findings.length === 0) return null;
  return (
    <Alert tone="caution" title={t('simrides.findings.title', { count: findings.length })}>
      <ul className="grid grid-cols-1 gap-1">
        {findings.map(f => (
          <li key={`${f.code}|${f.driver}|${f.weekMonday}`}>
            {f.driver}, {t('simrides.findings.week', { monday: f.weekMonday.split('-').reverse().join('.') })}: {t(FINDING_KEYS[f.code])}
            {f.detail ? ` (${f.detail})` : ''}
          </li>
        ))}
      </ul>
    </Alert>
  );
}

function ResultCard({ result, phase, onImport }: { result: Result; phase: Phase; onImport: () => void }) {
  const { t } = useTranslation();
  const { month, findings, explained } = result.generated;
  const completed = month.rides.filter(r => r.status === 'completed');
  const revenue = explained.reduce((sum, f) => sum + f.umsatz, 0) / 100;
  const done = phase === 'done';
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-3">
          <CardTitle>{t('simrides.summary.title')}</CardTitle>
          <SimulatedBadge />
        </div>
        <CardDescription>
          {result.poolCached ? t('simrides.summary.poolCached') : t('simrides.summary.poolFetched', { count: result.poolRequests })}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-4">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <KpiCard label={t('simrides.summary.weeks')} value={String(explained.length)} />
          <KpiCard label={t('simrides.summary.rides')} value={String(completed.length)} />
          <KpiCard label={t('simrides.summary.shifts')} value={String(month.shifts.length)} />
          <KpiCard label={t('simrides.summary.revenue')} value={formatEuro(revenue)} caption={t('simrides.summary.revenueNote')} />
        </div>
        <FindingsList findings={findings} />
        {done ? <Alert tone="positive" title={t('simrides.done.title')}>{t('simrides.done.body')}</Alert> : null}
        <div>
          <Button onClick={onImport} disabled={done || phase === 'importing'} loading={phase === 'importing'}>
            {t('simrides.action.import')}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
