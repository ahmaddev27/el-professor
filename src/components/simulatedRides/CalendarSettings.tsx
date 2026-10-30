import { Alert, Field, Input, formatNumber } from '../ui';
import { useTranslation } from '../../contexts/LanguageContext';
import type { TranslationKey } from '../../i18n';
import type { CalendarForm, CalendarFormField } from '../../utils/simulatedRides/calendarForm';
import type { MonthlyShareRate } from '../../utils/simulatedRides/monthlyRate';

/**
 * The calendar-month settings: declined orders (internal only), the
 * cancellation fee, the monthly share, and under "advanced" the zone, the
 * operating-day start, the shifts per vehicle and the safety margin on every
 * empty drive. Presentation only; `calendarForm.ts` reads what is typed here.
 */
const checkboxClass = 'mt-1 size-4 shrink-0 cursor-pointer accent-brand disabled:cursor-not-allowed';

const FIELD_ERROR_KEYS: Record<CalendarFormField, TranslationKey> = {
  timeZone: 'simrides.cal.error.timeZone',
  operatingDayStartHour: 'simrides.cal.error.dayStart',
  shiftsPerVehicleDay: 'simrides.cal.error.shifts',
  declinedFee: 'simrides.cal.error.fee',
  cancellationFee: 'simrides.cal.error.fee',
  marginSeconds: 'simrides.cal.error.marginSeconds',
  marginPercent: 'simrides.cal.error.marginPercent',
};

interface Props {
  form: CalendarForm;
  onChange: (patch: Partial<CalendarForm>) => void;
  disabled: boolean;
  errorField: CalendarFormField | null;
  /** The rate the seed draws for the chosen month, or null when the share is off or the month is unreadable. */
  ratePreview: MonthlyShareRate | null;
}

function Check({ checked, onChange, disabled, label, hint }: {
  checked: boolean; onChange: (value: boolean) => void; disabled: boolean; label: string; hint?: string;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3 text-sm text-fg">
      <input type="checkbox" className={checkboxClass} checked={checked} disabled={disabled} onChange={e => onChange(e.target.checked)} />
      <span>
        {label}
        {hint ? <span className="block text-xs text-fg-subtle">{hint}</span> : null}
      </span>
    </label>
  );
}

export function CalendarSettings({ form, onChange, disabled, errorField, ratePreview }: Props) {
  const { t } = useTranslation();
  const error = (field: CalendarFormField) => (errorField === field ? t(FIELD_ERROR_KEYS[field]) : undefined);
  return (
    <div className="grid grid-cols-1 gap-4">
      <fieldset className="m-0 grid min-w-0 grid-cols-1 gap-3 border-0 p-0" disabled={disabled}>
        <legend className="mb-1 text-[13px] font-medium text-fg-muted">{t('simrides.cal.declined.title')}</legend>
        <Check checked={form.declinedRidesEnabled} disabled={disabled} label={t('simrides.cal.declined.enabled')}
          hint={t('simrides.cal.declined.internalHint')}
          onChange={declinedRidesEnabled => onChange({ declinedRidesEnabled })} />
        <div className="max-w-xs">
          <Field label={t('simrides.cal.declined.fee')} hint={t('simrides.cal.declined.feeHint')} error={error('declinedFee')}>
            <Input inputMode="decimal" value={form.declinedFee} onChange={e => onChange({ declinedFee: e.target.value })} disabled={disabled || !form.declinedRidesEnabled} />
          </Field>
        </div>
      </fieldset>

      <fieldset className="m-0 grid min-w-0 grid-cols-1 gap-3 border-0 p-0" disabled={disabled}>
        <legend className="mb-1 text-[13px] font-medium text-fg-muted">{t('simrides.cal.cancellation.title')}</legend>
        <Check checked={form.cancellationFeeEnabled} disabled={disabled} label={t('simrides.cal.cancellation.enabled')}
          hint={t('simrides.cal.cancellation.hint')}
          onChange={cancellationFeeEnabled => onChange({ cancellationFeeEnabled })} />
        <div className="max-w-xs">
          <Field label={t('simrides.cal.cancellation.fee')} hint={t('simrides.cal.declined.feeHint')} error={error('cancellationFee')}>
            <Input inputMode="decimal" value={form.cancellationFee} onChange={e => onChange({ cancellationFee: e.target.value })}
              disabled={disabled || !form.cancellationFeeEnabled} />
          </Field>
        </div>
      </fieldset>

      <fieldset className="m-0 grid min-w-0 grid-cols-1 gap-3 border-0 p-0" disabled={disabled}>
        <legend className="mb-1 text-[13px] font-medium text-fg-muted">{t('simrides.cal.share.title')}</legend>
        <Check checked={form.monthlyRevenueShareEnabled} disabled={disabled} label={t('simrides.cal.share.enabled')}
          onChange={monthlyRevenueShareEnabled => onChange({ monthlyRevenueShareEnabled })} />
        <Check checked={form.basisIncludesTips} disabled={disabled || !form.monthlyRevenueShareEnabled} label={t('simrides.cal.share.tips')}
          onChange={basisIncludesTips => onChange({ basisIncludesTips })} />
        <Check checked={form.basisIncludesCancellationFees} disabled={disabled || !form.monthlyRevenueShareEnabled}
          label={t('simrides.cal.share.cancellationFees')} hint={t('simrides.cal.share.noDeclined')}
          onChange={basisIncludesCancellationFees => onChange({ basisIncludesCancellationFees })} />
        {ratePreview ? (
          <Alert tone="neutral" role="note">
            {t('simrides.cal.share.preview', { rate: formatNumber(ratePreview.ratePercent, 2) })}
          </Alert>
        ) : null}
      </fieldset>

      <details className="text-sm text-fg-muted">
        <summary className="cursor-pointer">{t('simrides.cal.advanced')}</summary>
        <div className="mt-3 grid max-w-xs grid-cols-1 gap-3">
          <Field label={t('simrides.cal.timeZone')} hint={t('simrides.cal.timeZoneHint')} error={error('timeZone')}>
            <Input value={form.timeZone} onChange={e => onChange({ timeZone: e.target.value })} disabled={disabled} />
          </Field>
          <Field label={t('simrides.cal.dayStart')} hint={t('simrides.cal.dayStartHint')} error={error('operatingDayStartHour')}>
            <Input type="number" min={0} max={23} value={form.operatingDayStartHour} onChange={e => onChange({ operatingDayStartHour: e.target.value })} disabled={disabled} />
          </Field>
          <Field label={t('simrides.cal.shifts')} hint={t('simrides.cal.shiftsHint')} error={error('shiftsPerVehicleDay')}>
            <Input type="number" min={1} max={3} value={form.shiftsPerVehicleDay} onChange={e => onChange({ shiftsPerVehicleDay: e.target.value })} disabled={disabled} />
          </Field>
          <Field label={t('simrides.cal.marginSeconds')} hint={t('simrides.cal.marginSecondsHint')} error={error('marginSeconds')}>
            <Input type="number" min={0} max={900} value={form.marginSeconds} onChange={e => onChange({ marginSeconds: e.target.value })} disabled={disabled} />
          </Field>
          <Field label={t('simrides.cal.marginPercent')} hint={t('simrides.cal.marginPercentHint')} error={error('marginPercent')}>
            <Input type="number" min={0} max={100} value={form.marginPercent} onChange={e => onChange({ marginPercent: e.target.value })} disabled={disabled} />
          </Field>
        </div>
      </details>
    </div>
  );
}
