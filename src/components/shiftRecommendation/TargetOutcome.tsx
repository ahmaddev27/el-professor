import { Alert, Button, formatEuroCents, formatNumber } from '../ui';
import { useTranslation } from '../../contexts/LanguageContext';
import type { TranslationKey } from '../../i18n';
import type { ShortfallBinding, ShortfallLeverName, TargetPlan } from '../../utils/shiftRecommendation';
import { minutesToHours } from '../../utils/shiftRecommendationScreens';

const BINDING_KEYS: Record<ShortfallBinding, TranslationKey> = {
  history_ceiling: 'shiftrec.target.binding.history_ceiling',
  fleet_size: 'shiftrec.target.binding.fleet_size',
  shift_rules: 'shiftrec.target.binding.shift_rules',
};

const LEVER_KEYS: Record<ShortfallLeverName, TranslationKey> = {
  break: 'shiftrec.target.lever.break',
  shifts_per_day: 'shiftrec.target.lever.shifts_per_day',
  min_shift: 'shiftrec.target.lever.min_shift',
  max_shift: 'shiftrec.target.lever.max_shift',
};

/**
 * Says whether the plan reached its target. A plan that fell short says so in
 * euros and names what bounded it; it is never shown as if it had succeeded.
 */
export function TargetOutcome({ plan, onSwap }: { plan: TargetPlan; onSwap: () => void }) {
  const { t } = useTranslation();
  if (plan.status !== 'ok' || plan.outcome === null) return null;
  const vars = {
    achieved: formatEuroCents(plan.achievedCents),
    target: formatEuroCents(plan.targetRevenueCents),
    gap: formatEuroCents(plan.gapCents),
    threshold: formatEuroCents(plan.thresholdCents),
  };
  if (plan.outcome === 'reached') {
    return <Alert tone="positive" title={t('shiftrec.target.reachedTitle')}>{t('shiftrec.target.reached', vars)}</Alert>;
  }
  if (plan.outcome === 'below_target' || plan.outcome === 'over_target') {
    const over = plan.outcome === 'over_target';
    return (
      <Alert tone="caution" title={t(over ? 'shiftrec.target.overTitle' : 'shiftrec.target.belowTitle')}>
        <div className="grid grid-cols-1 gap-3">
          <p>{t(over ? 'shiftrec.target.over' : 'shiftrec.target.below', { ...vars, excess: formatEuroCents(plan.achievedCents - plan.targetRevenueCents) })}</p>
          {plan.alternative ? <Other plan={plan} alternative={plan.alternative} onSwap={onSwap} /> : null}
        </div>
      </Alert>
    );
  }
  return (
    <Alert tone="critical" title={t('shiftrec.target.unreachableTitle')}>
      <div className="grid grid-cols-1 gap-3">
        <p>{t('shiftrec.target.unreachable', vars)}</p>
        {plan.shortfall ? <Shortfall shortfall={plan.shortfall} /> : null}
      </div>
    </Alert>
  );
}

function Other({ plan, alternative, onSwap }: { plan: TargetPlan; alternative: NonNullable<TargetPlan['alternative']>; onSwap: () => void }) {
  const { t } = useTranslation();
  const key = plan.outcome === 'over_target' ? 'shiftrec.target.stepDown' : 'shiftrec.target.nextStep';
  return (
    <div className="flex flex-wrap items-center gap-3">
      <p className="tabular-nums">
        {t(key, {
          threshold: formatEuroCents(alternative.thresholdCents),
          achieved: formatEuroCents(alternative.achievedCents),
          distance: formatEuroCents(alternative.distanceCents),
        })}
      </p>
      <Button variant="secondary" onClick={onSwap}>{t('shiftrec.target.useOther')}</Button>
    </div>
  );
}

function Shortfall({ shortfall }: { shortfall: NonNullable<TargetPlan['shortfall']> }) {
  const { t } = useTranslation();
  const hours = (minutes: number) => formatNumber(minutesToHours(minutes));
  return (
    <>
      <p className="font-semibold text-fg">
        {t(BINDING_KEYS[shortfall.binding], {
          history: formatEuroCents(shortfall.ceilingByHistoryCents),
          fleet: formatEuroCents(shortfall.ceilingByFleetCents),
        })}
      </p>
      {shortfall.binding === 'shift_rules' && shortfall.levers.length > 0 ? (
        <div>
          <p className="text-[13px] font-semibold text-fg-muted">{t('shiftrec.target.leversTitle')}</p>
          <ul className="mt-1 grid grid-cols-1 gap-1 tabular-nums">
            {shortfall.levers.map(lever => (
              <li key={lever.lever}>{t(LEVER_KEYS[lever.lever], { gain: formatEuroCents(Math.max(0, lever.gainCents)) })}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {shortfall.unratedSlotMinutes > 0 || shortfall.neverDrivenSlotMinutes > 0 ? (
        <p className="tabular-nums">
          {t('shiftrec.target.unpriced', {
            unrated: hours(shortfall.unratedSlotMinutes),
            never: hours(shortfall.neverDrivenSlotMinutes),
          })}
        </p>
      ) : null}
    </>
  );
}
