import React, { useState } from 'react';
import { X, Clock, Zap, AlertTriangle } from 'lucide-react';
import { usePlan } from '../contexts/PlanContext';
import { useTranslation } from '../contexts/LanguageContext';
import { cn } from './ui';

const TrialBanner: React.FC = () => {
  const { planState } = usePlan();
  const { t, tPlural } = useTranslation();
  const [dismissed, setDismissed] = useState(false);

  if (dismissed) return null;

  // ── Presentation (phase 5) ────────────────────────────────────────────────
  //
  // `urgent` and `warning` still decide the tone; only the colours they pick
  // moved, from the legacy `--danger/--warning/--accent` triples to the design
  // system's tones. The CTA keeps a fill a white label reads on: the design
  // system has no `caution` fill, so the seven-day banner's button is the brand
  // fill and the tone is carried by the bar, its icon and its words.

  // Show trial countdown
  if (planState.isInTrial) {
    const days = planState.trialDaysLeft;
    const urgent = days <= 3;
    const warning = days <= 7;

    const bar = urgent
      ? 'border-critical/20 bg-critical-soft text-critical'
      : warning
        ? 'border-caution/20 bg-caution-soft text-caution'
        : 'border-brand/20 bg-brand-soft text-brand-text';
    const cta = urgent ? 'bg-critical-solid text-brand-fg' : 'bg-brand text-brand-fg';
    const Icon = urgent ? AlertTriangle : Clock;

    return (
      <div className={cn('flex items-center justify-between gap-3 border-b px-4 py-2.5 text-xs font-medium', bar)}>
        <div className="flex min-w-0 items-center gap-2">
          <Icon size={13} className="shrink-0" />
          <span>
            {urgent
              ? tPlural({ one: 'trial.urgent.one', other: 'trial.urgent.other' }, days)
              : warning
                ? t('trial.warning', { count: days })
                : tPlural({ one: 'trial.active.one', other: 'trial.active.other' }, days)
            }
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <a
            href="mailto:support@el-professor.de?subject=Plan upgraden"
            className={cn('flex items-center gap-1 rounded-control px-2.5 py-1 text-xs font-semibold transition-opacity hover:opacity-80', cta)}
          >
            <Zap size={10} />
            {t('trial.choosePlan')}
          </a>
          <button
            onClick={() => setDismissed(true)}
            className="rounded p-0.5 transition-opacity hover:opacity-60"
          >
            <X size={13} />
          </button>
        </div>
      </div>
    );
  }

  // Show trial-expired warning
  if (planState.isTrialExpired) {
    return (
      <div className="flex items-center justify-between gap-3 border-b border-critical bg-critical-soft px-4 py-2.5 text-xs font-medium text-critical">
        <div className="flex items-center gap-2">
          <AlertTriangle size={13} className="shrink-0" />
          <span>
            {t('trial.expired')}
          </span>
        </div>
        <a
          href="mailto:support@el-professor.de?subject=Plan upgraden"
          className="flex shrink-0 items-center gap-1 rounded-control bg-critical-solid px-2.5 py-1 text-xs font-semibold text-brand-fg transition-opacity hover:opacity-80"
        >
          <Zap size={10} />
          {t('trial.choosePlan')}
        </a>
      </div>
    );
  }

  return null;
};

export default TrialBanner;
