import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, PageHeader, cn } from '../components/ui';
import { DataStep, type DataStepError, type ImportsState } from '../components/shiftRecommendation/DataStep';
import { ResultStep } from '../components/shiftRecommendation/ResultStep';
import { SettingsStep, type AdvancedSettings } from '../components/shiftRecommendation/SettingsStep';
import { useSuperAdmin } from '../contexts/SuperAdminContext';
import { useTranslation } from '../contexts/LanguageContext';
import { loadImports, loadSettings, loadTripRows, type ImportSummary } from '../lib/tripAnalysisClient';
import type { TranslationKey } from '../i18n';
import { analysisTripFromRow } from '../utils/tripAnalysis';
import type { AnalysisTrip, TripRowForAnalysis } from '../utils/tripAnalysis/types';
import {
  DEFAULT_PROFILE_SETTINGS,
  buildDemandProfile,
  planForTarget,
  recommendShifts,
  swapToAlternative,
  validatePlanSettings,
  validateProfileSettings,
  type DemandProfile,
  type ProfileSettings,
  type ShiftRecommendation,
  type TargetPlan,
  type YearMonth,
} from '../utils/shiftRecommendation';
import { referenceStats, type ReferenceStats, type ReferenceTripRow } from '../utils/shiftRecommendationReference';
import {
  attempt,
  defaultHistoryKeys,
  defaultPlanForm,
  effectiveBlockGap,
  historyMonthOptions,
  holidaySet,
  monthKey,
  parseMonthKey,
  planSettingsFromForm,
  selectedHistory,
  targetMonthOptions,
  targetPlanSettingsFromForm,
  targetRevenueCents,
  yearsTouched,
  type PlanForm,
} from '../utils/shiftRecommendationScreens';

/**
 * Typ 2 of the monthly plan: when should each vehicle be on the road?
 *
 * Three steps, all in memory. The page reads imports and trips and nothing
 * else, writes nothing, creates no ride and assigns no driver — the standard
 * plan does that. The trips of the chosen months are read once and kept: the
 * profile is rebuilt from them when a profile setting changes, never re-fetched.
 *
 * A figure from a failed read is not shown. Each failure has its own Alert and
 * leaves the step where it was.
 */
type Step = 1 | 2 | 3;
const STEP_KEYS: Record<Step, TranslationKey> = { 1: 'shiftrec.step1', 2: 'shiftrec.step2', 3: 'shiftrec.step3' };

interface LoadedHistory {
  trips: AnalysisTrip[];
  months: YearMonth[];
  target: YearMonth;
  /** Measured from the loaded rows, outside the recommendation module: see shiftRecommendationReference.ts. */
  reference: ReferenceStats;
}

interface Result {
  recommendation: ShiftRecommendation;
  profile: DemandProfile;
  /** Set when the month was planned towards a revenue target. */
  targetPlan: TargetPlan | null;
}

const DEFAULT_ADVANCED: AdvancedSettings = {
  operatingDayStartHour: DEFAULT_PROFILE_SETTINGS.operatingDayStartHour,
  slotMinutes: DEFAULT_PROFILE_SETTINGS.slotMinutes,
  minEvidenceDays: DEFAULT_PROFILE_SETTINGS.minEvidenceDays,
  region: '',
};

export default function ShiftRecommendationPage() {
  const { t } = useTranslation();
  const { effectiveCompanyId: companyId } = useSuperAdmin();

  const [step, setStep] = useState<Step>(1);
  const [importRows, setImportRows] = useState<ImportSummary[]>([]);
  const [importsState, setImportsState] = useState<ImportsState>('loading');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [targetKey, setTargetKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [dataError, setDataError] = useState<DataStepError>(null);
  const [loaded, setLoaded] = useState<LoadedHistory | null>(null);
  const [blockGap, setBlockGap] = useState(DEFAULT_PROFILE_SETTINGS.blockGapMinutes);
  const [advanced, setAdvanced] = useState<AdvancedSettings>(DEFAULT_ADVANCED);
  const [form, setForm] = useState<PlanForm>(defaultPlanForm(null));
  const [vehicleSelection, setVehicleSelection] = useState<ReadonlySet<string>>(new Set());
  const [computeFailed, setComputeFailed] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const requestRef = useRef(0);

  // ── Imports ────────────────────────────────────────────────────────────
  const reloadImports = useCallback(() => {
    if (!companyId) return;
    const request = ++requestRef.current;
    setImportsState('loading');
    loadImports(companyId)
      .then(rows => {
        if (request !== requestRef.current) return;
        const options = historyMonthOptions(rows);
        setImportRows(rows);
        setSelected(new Set(defaultHistoryKeys(options)));
        const newest = options[0];
        setTargetKey(newest ? monthKey(targetMonthOptions(newest)[0]) : '');
        setImportsState('ready');
      })
      .catch((error: unknown) => {
        console.error('Schichtempfehlung: loading the imports failed', error);
        if (request === requestRef.current) setImportsState('failed');
      });
  }, [companyId]);

  useEffect(() => {
    // A different company is a different history: nothing read for the old one may stay on screen.
    setStep(1);
    setLoaded(null);
    setResult(null);
    setDataError(null);
    // A load for the old company may still be running; its own finally no longer clears this.
    setBusy(false);
    reloadImports();
    return () => { requestRef.current += 1; };
  }, [reloadImports]);

  const options = useMemo(() => historyMonthOptions(importRows), [importRows]);
  const targets = useMemo(() => (options[0] ? targetMonthOptions(options[0]) : []), [options]);

  // ── The profile ────────────────────────────────────────────────────────
  const profileSettings: ProfileSettings = useMemo(
    () => ({
      slotMinutes: advanced.slotMinutes,
      operatingDayStartHour: advanced.operatingDayStartHour,
      blockGapMinutes: blockGap,
      minEvidenceDays: advanced.minEvidenceDays,
    }),
    [advanced, blockGap],
  );
  const holidays = useMemo(
    () => (loaded ? holidaySet(yearsTouched(loaded.months, loaded.target), advanced.region) : new Set<string>()),
    [loaded, advanced.region],
  );
  const profileAttempt = useMemo(
    () => (loaded ? attempt(() => buildDemandProfile({ trips: loaded.trips, historyMonths: loaded.months, holidays, settings: profileSettings })) : null),
    [loaded, holidays, profileSettings],
  );
  const profile = profileAttempt?.ok ? profileAttempt.value : null;

  const planSettings = useMemo(() => planSettingsFromForm(form), [form]);
  const planProblems = useMemo(() => {
    if (!profile || profile.status !== 'ok') return [];
    // An unreadable threshold has its own message; the rest is checked with a zero in its place.
    // In target mode the threshold is searched, never read from the form, so a zero stands in always.
    const checked = form.mode === 'target' || planSettings === null ? planSettingsFromForm({ ...form, thresholdText: '0' }) : planSettings;
    return [
      ...validateProfileSettings(profileSettings),
      ...(checked ? validatePlanSettings(checked, profile.settings.slotMinutes) : []),
    ];
  }, [profile, planSettings, form, profileSettings]);

  // ── Step 1 → 2: read the trips, build the profile ──────────────────────
  const goToSettings = async () => {
    const target = parseMonthKey(targetKey);
    if (!companyId || !target) return;
    const chosen = selectedHistory(options, selected);
    const request = ++requestRef.current;
    setBusy(true);
    setDataError(null);
    try {
      const gap = await loadGap(companyId);
      const perMonth = await Promise.all(chosen.map(o => loadTripRows(companyId, o.importId)));
      if (request !== requestRef.current) return;
      const trips = perMonth.flat().map(analysisTripFromRow);
      const months = chosen.map(o => ({ year: o.year, month: o.month }));
      // The rows are selected with `*`, so the money columns the adapter drops are present.
      const reference = referenceStats(chosen.map((o, i) => ({ year: o.year, month: o.month, rows: perMonth[i] as readonly (TripRowForAnalysis & ReferenceTripRow)[] })));
      startProfile({ trips, months, target, reference }, gap);
    } catch (error) {
      console.error('Schichtempfehlung: reading the rides failed', error);
      if (request === requestRef.current) setDataError('trips');
    } finally {
      if (request === requestRef.current) setBusy(false);
    }
  };

  /** Builds once here so a failed build keeps step 1 on screen; the memo repeats it for later edits. */
  const startProfile = (history: LoadedHistory, gap: number) => {
    const settings = { ...profileSettings, blockGapMinutes: gap };
    const built = attempt(() =>
      buildDemandProfile({ trips: history.trips, historyMonths: history.months, holidays: holidaySet(yearsTouched(history.months, history.target), advanced.region), settings }),
    );
    if (!built.ok) {
      setDataError('profile');
      return;
    }
    setBlockGap(gap);
    setLoaded(history);
    setForm(defaultPlanForm(built.value.perMonth.revenuePerHourCents, built.value.perMonth.revenueCents));
    setVehicleSelection(new Set(built.value.vehicles.map(v => v.vehicle)));
    setResult(null);
    setComputeFailed(false);
    setStep(2);
  };

  // ── Step 2 → 3 ─────────────────────────────────────────────────────────
  const compute = () => {
    if (!loaded || !profile) return;
    const vehicles = profile.vehicles.map(v => v.vehicle).filter(v => vehicleSelection.has(v));
    const targetCents = targetRevenueCents(form.targetText);
    if (form.mode === 'target') {
      if (targetCents === null) return;
      const outcome = attempt(() =>
        planForTarget({ profile, target: loaded.target, vehicles, holidays, settings: targetPlanSettingsFromForm(form), targetRevenueCents: targetCents }),
      );
      finishCompute(outcome.ok ? { recommendation: outcome.value.recommendation, profile, targetPlan: outcome.value } : null);
      return;
    }
    if (!planSettings) return;
    const outcome = attempt(() => recommendShifts({ profile, target: loaded.target, vehicles, holidays, settings: planSettings }));
    finishCompute(outcome.ok ? { recommendation: outcome.value, profile, targetPlan: null } : null);
  };

  const finishCompute = (next: Result | null) => {
    if (!next) {
      setComputeFailed(true);
      return;
    }
    setComputeFailed(false);
    setResult(next);
    setStep(3);
  };

  const toggle = (set: ReadonlySet<string>, value: string): Set<string> => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    return next;
  };

  if (!companyId) {
    return (
      <div className="font-ui">
        <PageHeader title={t('shiftrec.title')} description={t('shiftrec.subtitle')} />
        <Alert tone="critical">{t('shiftrec.noCompany')}</Alert>
      </div>
    );
  }

  return (
    <div className="font-ui">
      <PageHeader title={t('shiftrec.title')} description={t('shiftrec.subtitle')}>
        <ol className="flex flex-wrap items-center gap-2" aria-label={t('shiftrec.stepsLabel')}>
          {([1, 2, 3] as const).map(number => (
            <li key={number}>
              <span
                aria-current={number === step ? 'step' : undefined}
                className={cn(
                  'inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[13px]',
                  number === step
                    ? 'border-brand bg-brand-soft font-semibold text-brand-text'
                    : number < step
                      ? 'border-line bg-sunken text-fg'
                      : 'border-line bg-raised text-fg-subtle',
                )}
              >
                <span className="tabular-nums">{number}</span>
                {t(STEP_KEYS[number])}
              </span>
            </li>
          ))}
        </ol>
      </PageHeader>

      {step === 1 ? (
        <DataStep
          importsState={importsState}
          options={options}
          selected={selected}
          onToggle={key => setSelected(current => toggle(current, key))}
          targets={targets}
          target={targetKey}
          onTarget={setTargetKey}
          busy={busy}
          error={dataError}
          onRetry={reloadImports}
          onNext={() => void goToSettings()}
        />
      ) : null}
      {step === 2 ? (
        <SettingsStep
          profile={profile}
          advanced={advanced}
          onAdvanced={patch => setAdvanced(current => ({ ...current, ...patch }))}
          form={form}
          onForm={patch => setForm(current => ({ ...current, ...patch }))}
          selectedVehicles={vehicleSelection}
          onToggleVehicle={vehicle => setVehicleSelection(current => toggle(current, vehicle))}
          thresholdInvalid={form.mode === 'threshold' && planSettings === null}
          targetInvalid={form.mode === 'target' && targetRevenueCents(form.targetText) === null}
          reference={loaded?.reference ?? null}
          targetMonth={loaded?.target ?? null}
          planProblems={planProblems}
          computeFailed={computeFailed}
          onBack={() => setStep(1)}
          onCompute={compute}
        />
      ) : null}
      {step === 3 && result ? (
        <ResultStep profile={result.profile} recommendation={result.recommendation} targetPlan={result.targetPlan}
          onSwapTarget={() => setResult(current => swapResult(current))}
          onBack={() => setStep(2)} />
      ) : null}
    </div>
  );
}

/** The plan on the other side of the target, with the profile it was computed from; anything else is left as it is. */
function swapResult(current: Result | null): Result | null {
  if (!current?.targetPlan?.alternative) return current;
  const swapped = swapToAlternative(current.targetPlan);
  return { ...current, recommendation: swapped.recommendation, targetPlan: swapped };
}

/**
 * The company's block gap, else the default. It is a preference: a failed read
 * must not stop the page, so the default stands and the failure is only logged.
 */
async function loadGap(companyId: string): Promise<number> {
  try {
    const row = await loadSettings(companyId);
    return effectiveBlockGap(row?.block_gap_minutes, DEFAULT_PROFILE_SETTINGS.blockGapMinutes);
  } catch (error) {
    console.error('Schichtempfehlung: reading the block gap failed, using the default', error);
    return DEFAULT_PROFILE_SETTINGS.blockGapMinutes;
  }
}
