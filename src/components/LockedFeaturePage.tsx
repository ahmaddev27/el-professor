import React from 'react';
import { Lock, Zap, ArrowLeft } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Plan } from '../contexts/PlanContext';
import { useTranslation } from '../contexts/LanguageContext';
import type { TranslationKey } from '../i18n';
import { Button, cn } from './ui';

interface LockedFeaturePageProps {
  featureName: string;
  requiredPlan: Plan;
}

const PLAN_LABELS: Record<Plan, string> = {
  basic: 'Basic',
  advanced: 'Advanced',
  premium: 'Premium',
};

const LockedFeaturePage: React.FC<LockedFeaturePageProps> = ({ featureName, requiredPlan }) => {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const planLabel = t('locked.planSuffix', { plan: PLAN_LABELS[requiredPlan] });

  // Feature names shown in the plan comparison. Statutory terms (Werkstatt,
  // Abrechnung, Stundennachweis) resolve to themselves in English.
  const ADVANCED_FEATURES: TranslationKey[] = [
    'nav.werkstatt', 'nav.abrechnung', 'nav.notes',
    'locked.feature.rollenNutzer', 'nav.notifications',
  ];
  const PREMIUM_FEATURES: TranslationKey[] = [
    'nav.salaries', 'locked.feature.trinkgeld', 'locked.feature.stundennachweis',
    'locked.feature.allAdvanced',
  ];

  // ── Presentation (phase 5) ────────────────────────────────────────────────
  // Everything above is the screen's logic and is unchanged; everything below
  // only draws it.

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center px-4 text-center font-ui">
      <div className="mb-5 flex size-16 items-center justify-center rounded-surface bg-sunken text-fg-subtle shadow-hi">
        <Lock aria-hidden className="size-7" />
      </div>

      <h2 className="mb-2 text-xl font-semibold tracking-tight text-fg">
        {t('locked.title', { feature: featureName })}
      </h2>

      <p className="mb-6 max-w-sm text-sm leading-relaxed text-fg-muted">
        {t('locked.body.before')}{' '}
        <span className={cn('rounded-chip px-1.5 py-0.5 font-semibold', PLAN_TONE[requiredPlan].pill)}>
          {planLabel}
        </span>{' '}
        {t('locked.body.after')}
      </p>

      <div className="flex flex-wrap items-center justify-center gap-3">
        <Button variant="secondary" onClick={() => navigate('/overview')}>
          <ArrowLeft aria-hidden />
          {t('locked.backToOverview')}
        </Button>

        <Button asChild>
          <a href="mailto:support@el-professor.de?subject=Plan upgraden">
            <Zap aria-hidden />
            {t('locked.upgrade')}
          </a>
        </Button>
      </div>

      {/* Plan comparison hint */}
      <div className="glass-card mt-8 w-full max-w-sm rounded-surface p-4 text-left">
        <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-fg-subtle">
          {t('locked.availableIn', { plan: PLAN_LABELS[requiredPlan] })}
        </p>
        {requiredPlan === 'advanced' && (
          <ul className="space-y-1.5 text-sm text-fg-muted">
            {ADVANCED_FEATURES.map(key => (
              <li key={key} className="flex items-center gap-2">
                <span aria-hidden className={cn('size-1.5 shrink-0 rounded-full', PLAN_TONE.advanced.dot)} />
                {t(key)}
              </li>
            ))}
          </ul>
        )}
        {requiredPlan === 'premium' && (
          <ul className="space-y-1.5 text-sm text-fg-muted">
            {PREMIUM_FEATURES.map(key => (
              <li key={key} className="flex items-center gap-2">
                <span aria-hidden className={cn('size-1.5 shrink-0 rounded-full', PLAN_TONE.premium.dot)} />
                {t(key)}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
};

/**
 * Each plan keeps the hue it had (basic blue, advanced amber, premium green),
 * now as a tone: the word on its soft fill for the pill, the tone's dot for
 * the list markers.
 */
const PLAN_TONE: Record<Plan, { pill: string; dot: string }> = {
  basic: { pill: 'bg-info-soft text-info', dot: 'bg-info-dot' },
  advanced: { pill: 'bg-caution-soft text-caution', dot: 'bg-caution-dot' },
  premium: { pill: 'bg-positive-soft text-positive', dot: 'bg-positive-dot' },
};

export default LockedFeaturePage;
