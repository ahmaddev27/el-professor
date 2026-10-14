import { Alert, Button, Card, CardContent, CardHeader, CardTitle, Field, Input, NativeSelect, formatEuroCents, formatNumber } from '../ui';
import type { TranslationKey } from '../../i18n';
import { useTranslation } from '../../contexts/LanguageContext';
import type { DemandProfile, SettingsProblem, YearMonth } from '../../utils/shiftRecommendation';
import type { ReferenceStats } from '../../utils/shiftRecommendationReference';
import { ReferencePanel } from './ReferencePanel';
import type { ScenarioField } from '../../utils/shiftRecommendationScenario';
import {
  BLOCK_CHOICE_KEYS,
  BREAK_CHOICES,
  EXCLUSION_KEYS,
  HOLIDAY_REGIONS,
  MAX_SHIFTS_CHOICES,
  MAX_SHIFT_CHOICES,
  MIN_SHIFT_CHOICES,
  MONTH_NAME_KEYS,
  OPERATIONAL_BLOCK_CHOICES,
  OPERATIONAL_BREAK_CHOICES,
  PROBLEM_KEYS,
  REGION_KEYS,
  SLOT_CHOICES,
  exclusionRows,
  formatDuration,
  minutesToHours,
  withCurrentChoice,
  type PlanForm,
} from '../../utils/shiftRecommendationScreens';

/** The profile settings the "Erweitert" section edits; the block gap comes from the company's own setting. */
export interface AdvancedSettings {
  operatingDayStartHour: number;
  slotMinutes: number;
  minEvidenceDays: number;
  /** '' = nationwide holidays only. */
  region: string;
}

interface Props {
  /** null when the profile could not be built: nothing is shown in its place. */
  profile: DemandProfile | null;
  advanced: AdvancedSettings;
  onAdvanced: (patch: Partial<AdvancedSettings>) => void;
  form: PlanForm;
  onForm: (patch: Partial<PlanForm>) => void;
  selectedVehicles: ReadonlySet<string>;
  onToggleVehicle: (vehicle: string) => void;
  thresholdInvalid: boolean;
  /** The target text is not an amount (only matters in 'target' mode). */
  targetInvalid: boolean;
  /** Scenario fields whose text is not a value; each is marked and the compute button stays off. */
  scenarioInvalid: readonly ScenarioField[];
  /** What the chosen months look like; null until they are read. */
  reference: ReferenceStats | null;
  /** The month being planned, chosen in step 1. */
  targetMonth: YearMonth | null;
  planProblems: readonly SettingsProblem[];
  computeFailed: boolean;
  onBack: () => void;
  onCompute: () => void;
}

const SHARE_FIELDS: { field: ScenarioField; label: TranslationKey; hint: TranslationKey }[] = [
  { field: 'cancellationText', label: 'shiftrec.scenario.cancel.label', hint: 'shiftrec.scenario.cancel.hint' },
  { field: 'tipText', label: 'shiftrec.scenario.tip.label', hint: 'shiftrec.scenario.tip.hint' },
  { field: 'cashText', label: 'shiftrec.scenario.cash.label', hint: 'shiftrec.scenario.cash.hint' },
];

const HOURS_OF_DAY = Array.from({ length: 24 }, (_, i) => i);
const EVIDENCE_CHOICES = [1, 2, 3, 4, 5];

export function SettingsStep(props: Props) {
  const { t } = useTranslation();
  const { profile } = props;
  const usable = profile !== null && profile.status === 'ok';
  const vehicleCount = profile ? profile.vehicles.filter(v => props.selectedVehicles.has(v.vehicle)).length : 0;
  const blocked = !usable || props.thresholdInvalid || props.targetInvalid || props.scenarioInvalid.length > 0 || props.planProblems.length > 0 || vehicleCount === 0;
  const duration = (minutes: number) => t('shiftrec.duration', { value: formatDuration(minutes) });

  return (
    <div className="grid grid-cols-1 gap-4">
      {profile === null ? (
        <Alert tone="critical" title={t('shiftrec.data.profileFailedTitle')}>
          {t('shiftrec.data.profileFailed')}
        </Alert>
      ) : (
        <Coverage profile={profile} />
      )}
      {props.reference ? <ReferencePanel stats={props.reference} /> : null}

      {usable ? (
        <Card>
          <CardHeader>
            <CardTitle>{t('shiftrec.vehicles.title')}</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-1 gap-2">
            <p className="text-[13px] text-fg-subtle">{t('shiftrec.vehicles.hint')}</p>
            {profile.vehicles.length === 0 ? <p className="text-sm text-fg-muted">{t('shiftrec.vehicles.none')}</p> : null}
            {profile.vehicles.map(v => (
              <label key={v.vehicle} className="flex cursor-pointer items-start gap-3 rounded-surface border border-line bg-raised p-3">
                <input
                  type="checkbox"
                  checked={props.selectedVehicles.has(v.vehicle)}
                  onChange={() => props.onToggleVehicle(v.vehicle)}
                  className="mt-0.5 size-4 shrink-0 accent-brand [@media(pointer:coarse)]:size-5"
                />
                <span className="min-w-0">
                  <span className="block break-words text-sm font-semibold text-fg">{v.vehicle}</span>
                  <span className="block text-[13px] text-fg-muted tabular-nums">
                    {t('shiftrec.vehicles.stats', {
                      rides: formatNumber(v.rides),
                      hours: formatNumber(minutesToHours(v.vehicleMinutesPerMonth)),
                      rate: v.revenuePerHourCents === null ? t('shiftrec.vehicles.noRate') : formatEuroCents(v.revenuePerHourCents),
                    })}
                  </span>
                </span>
              </label>
            ))}
            {vehicleCount === 0 && profile.vehicles.length > 0 ? (
              <p className="text-[13px] text-critical">{t('shiftrec.vehicles.noneSelected')}</p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>{t('shiftrec.ops.title')}</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {props.targetMonth ? (
              <Field label={t('shiftrec.ops.month')}>
                <p className="text-sm font-semibold text-fg">
                  {t(MONTH_NAME_KEYS[props.targetMonth.month - 1])} {props.targetMonth.year}
                </p>
              </Field>
            ) : null}
            <Field label={t('shiftrec.ops.maxBlock.label')} hint={t('shiftrec.ops.maxBlock.hint')}>
              <NativeSelect value={props.form.maxShiftMinutes} onChange={e => props.onForm({ maxShiftMinutes: Number(e.target.value) })}>
                {withCurrentChoice(OPERATIONAL_BLOCK_CHOICES, props.form.maxShiftMinutes).map(option => (
                  <option key={option.value} value={option.value}>
                    {option.custom
                      ? t('shiftrec.ops.custom', { value: duration(option.value) })
                      : t(BLOCK_CHOICE_KEYS[option.value as (typeof OPERATIONAL_BLOCK_CHOICES)[number]])}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field label={t('shiftrec.ops.break.label')}>
              <NativeSelect value={props.form.minBreakMinutes} onChange={e => props.onForm({ minBreakMinutes: Number(e.target.value) })}>
                {withCurrentChoice(OPERATIONAL_BREAK_CHOICES, props.form.minBreakMinutes).map(option => (
                  <option key={option.value} value={option.value}>
                    {option.custom
                      ? t('shiftrec.ops.custom', { value: t('shiftrec.minutes', { value: option.value }) })
                      : t('shiftrec.minutes', { value: option.value })}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('shiftrec.settings.title')}</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label={t('shiftrec.mode.label')}>
              <NativeSelect value={props.form.mode} onChange={e => props.onForm({ mode: e.target.value as PlanForm['mode'] })}>
                <option value="target">{t('shiftrec.mode.target')}</option>
                <option value="threshold">{t('shiftrec.mode.threshold')}</option>
              </NativeSelect>
            </Field>
            {props.form.mode === 'target' ? (
              <Field
                label={t('shiftrec.target.label')}
                hint={
                  profile && profile.perMonth.revenueCents > 0
                    ? t('shiftrec.target.hint', { amount: formatEuroCents(profile.perMonth.revenueCents) })
                    : undefined
                }
                error={props.targetInvalid ? t('shiftrec.target.invalid') : undefined}
              >
                <Input
                  inputMode="decimal"
                  value={props.form.targetText}
                  onChange={e => props.onForm({ targetText: e.target.value })}
                  className="tabular-nums"
                />
              </Field>
            ) : (
              <Field
                label={t('shiftrec.threshold.label')}
                hint={
                  profile?.perMonth.revenuePerHourCents != null
                    ? t('shiftrec.threshold.hint', { rate: formatEuroCents(profile.perMonth.revenuePerHourCents) })
                    : undefined
                }
                error={props.thresholdInvalid ? t('shiftrec.threshold.invalid') : undefined}
              >
                <Input
                  inputMode="decimal"
                  value={props.form.thresholdText}
                  onChange={e => props.onForm({ thresholdText: e.target.value })}
                  className="tabular-nums"
                />
              </Field>
            )}
          </div>

          <details className="rounded-surface border border-line bg-raised p-3">
            <summary className="cursor-pointer text-sm font-semibold text-fg">{t('shiftrec.ops.free')}</summary>
            <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label={t('shiftrec.maxShifts.label')}>
                <NativeSelect value={props.form.maxShiftsPerVehiclePerDay} onChange={e => props.onForm({ maxShiftsPerVehiclePerDay: Number(e.target.value) })}>
                  {MAX_SHIFTS_CHOICES.map(n => <option key={n} value={n}>{n}</option>)}
                </NativeSelect>
              </Field>
              <Field label={t('shiftrec.shiftMin.label')}>
                <NativeSelect value={props.form.minShiftMinutes} onChange={e => props.onForm({ minShiftMinutes: Number(e.target.value) })}>
                  {MIN_SHIFT_CHOICES.map(m => <option key={m} value={m}>{duration(m)}</option>)}
                </NativeSelect>
              </Field>
              <Field label={t('shiftrec.shiftMax.label')} hint={t('shiftrec.shiftMax.hint')}>
                <NativeSelect value={props.form.maxShiftMinutes} onChange={e => props.onForm({ maxShiftMinutes: Number(e.target.value) })}>
                  {MAX_SHIFT_CHOICES.map(m => <option key={m} value={m}>{duration(m)}</option>)}
                </NativeSelect>
              </Field>
              <Field label={t('shiftrec.break.label')}>
                <NativeSelect value={props.form.minBreakMinutes} onChange={e => props.onForm({ minBreakMinutes: Number(e.target.value) })}>
                  {BREAK_CHOICES.map(m => <option key={m} value={m}>{t('shiftrec.minutes', { value: m })}</option>)}
                </NativeSelect>
              </Field>
            </div>
          </details>

          <details className="rounded-surface border border-line bg-raised p-3">
            <summary className="cursor-pointer text-sm font-semibold text-fg">{t('shiftrec.advanced.title')}</summary>
            <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label={t('shiftrec.dayStart.label')} hint={t('shiftrec.dayStart.hint')}>
                <NativeSelect value={props.advanced.operatingDayStartHour} onChange={e => props.onAdvanced({ operatingDayStartHour: Number(e.target.value) })}>
                  {HOURS_OF_DAY.map(h => <option key={h} value={h}>{h}</option>)}
                </NativeSelect>
              </Field>
              <Field label={t('shiftrec.slot.label')}>
                <NativeSelect value={props.advanced.slotMinutes} onChange={e => props.onAdvanced({ slotMinutes: Number(e.target.value) })}>
                  {SLOT_CHOICES.map(m => <option key={m} value={m}>{m}</option>)}
                </NativeSelect>
              </Field>
              <Field label={t('shiftrec.evidence.label')} hint={t('shiftrec.evidence.hint')}>
                <NativeSelect value={props.advanced.minEvidenceDays} onChange={e => props.onAdvanced({ minEvidenceDays: Number(e.target.value) })}>
                  {EVIDENCE_CHOICES.map(n => <option key={n} value={n}>{n}</option>)}
                </NativeSelect>
              </Field>
              <Field label={t('shiftrec.region.label')}>
                <NativeSelect value={props.advanced.region} onChange={e => props.onAdvanced({ region: e.target.value })}>
                  <option value="">{t('shiftrec.region.federal')}</option>
                  {HOLIDAY_REGIONS.map(code => <option key={code} value={code}>{t(REGION_KEYS[code])}</option>)}
                </NativeSelect>
              </Field>
            </div>
          </details>

          <fieldset className="grid grid-cols-1 gap-4 rounded-surface border border-line bg-raised p-3">
            <legend className="px-1 text-sm font-semibold text-fg">{t('shiftrec.scenario.title')}</legend>
            <p className="text-[13px] text-fg-subtle">{t('shiftrec.scenario.intro')}</p>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field
                label={t('shiftrec.scenario.trips.label')}
                hint={t('shiftrec.scenario.trips.hint')}
                error={props.scenarioInvalid.includes('targetTripsText') ? t('shiftrec.scenario.trips.invalid') : undefined}
              >
                <Input inputMode="numeric" value={props.form.targetTripsText} onChange={e => props.onForm({ targetTripsText: e.target.value })} className="tabular-nums" />
              </Field>
              {SHARE_FIELDS.map(({ field, label, hint }) => (
                <Field
                  key={field}
                  label={t(label)}
                  hint={t(hint)}
                  error={props.scenarioInvalid.includes(field) ? t('shiftrec.scenario.share.invalid') : undefined}
                >
                  <Input inputMode="decimal" value={props.form[field]} onChange={e => props.onForm({ [field]: e.target.value })} className="tabular-nums" />
                </Field>
              ))}
            </div>
          </fieldset>

          {props.planProblems.length > 0 ? (
            <Alert tone="caution">
              <ul className="grid grid-cols-1 gap-1">
                {props.planProblems.map(problem => <li key={problem}>{t(PROBLEM_KEYS[problem])}</li>)}
              </ul>
            </Alert>
          ) : null}
          {props.computeFailed ? (
            <Alert tone="critical" title={t('shiftrec.computeFailedTitle')}>
              {t('shiftrec.computeFailed')}
            </Alert>
          ) : null}

          <div className="flex flex-wrap items-center gap-3">
            <Button variant="secondary" onClick={props.onBack}>{t('shiftrec.back')}</Button>
            <Button onClick={props.onCompute} disabled={blocked}>{t('shiftrec.compute')}</Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

/** What the profile did and did not learn from: the operator should see what the estimate rests on. */
function Coverage({ profile }: { profile: DemandProfile }) {
  const { t } = useTranslation();
  const { coverage } = profile;
  const excluded = exclusionRows(coverage.excluded);
  const excludedTotal = excluded.reduce((sum, row) => sum + row.count, 0);
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('shiftrec.coverage.title')}</CardTitle>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-4">
        {profile.status === 'no_history' ? <Alert tone="caution">{t('shiftrec.profile.noHistory')}</Alert> : null}
        {profile.status === 'invalid_settings' ? (
          <Alert tone="caution" title={t('shiftrec.profile.invalidSettings')}>
            <ul className="grid grid-cols-1 gap-1">
              {profile.problems.map(problem => <li key={problem}>{t(PROBLEM_KEYS[problem])}</li>)}
            </ul>
          </Alert>
        ) : null}
        <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <Stat label={t('shiftrec.coverage.months')} value={formatNumber(profile.historyMonths.length)} />
          <Stat label={t('shiftrec.coverage.usedRides')} value={formatNumber(coverage.usedRides)} />
          <Stat label={t('shiftrec.coverage.excludedRides')} value={formatNumber(excludedTotal)} />
          <Stat label={t('shiftrec.coverage.unplaced')} value={formatEuroCents(coverage.unplacedRevenueCents)} />
          <Stat label={t('shiftrec.coverage.cancelled')} value={formatEuroCents(coverage.cancelledRevenueCents)} />
        </dl>
        {excluded.length > 0 ? (
          <div>
            <p className="text-[13px] font-semibold text-fg-muted">{t('shiftrec.coverage.excludedBy')}</p>
            <ul className="mt-1 grid grid-cols-1 gap-1 text-sm text-fg-muted">
              {excluded.map(row => (
                <li key={row.reason} className="flex justify-between gap-3">
                  <span>{t(EXCLUSION_KEYS[row.reason])}</span>
                  <span className="tabular-nums">{formatNumber(row.count)}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[13px] text-fg-subtle">{label}</dt>
      <dd className="font-semibold tabular-nums text-fg">{value}</dd>
    </div>
  );
}
