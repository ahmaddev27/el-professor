import React, { useState } from 'react';
import { X, Clock, Zap, AlertTriangle } from 'lucide-react';
import { usePlan } from '../contexts/PlanContext';
import { useTranslation } from '../contexts/LanguageContext';

const TrialBanner: React.FC = () => {
  const { planState } = usePlan();
  const { t, tPlural } = useTranslation();
  const [dismissed, setDismissed] = useState(false);

  if (dismissed) return null;

  // Show trial countdown
  if (planState.isInTrial) {
    const days = planState.trialDaysLeft;
    const urgent = days <= 3;
    const warning = days <= 7;

    const bg = urgent
      ? 'var(--danger-subtle)'
      : warning
        ? 'var(--warning-subtle)'
        : 'var(--accent-subtle)';
    const color = urgent
      ? 'var(--danger)'
      : warning
        ? 'var(--warning)'
        : 'var(--accent)';
    // The CTA below is a FILL under a white label, which is a different role
    // from `color`, the banner's text on its pale `bg`. In the dark theme the
    // two cannot be one value — see the note above the dark block in index.css.
    const fill = urgent
      ? 'var(--danger-solid)'
      : warning
        ? 'var(--warning-solid)'
        : 'var(--accent)';
    const Icon = urgent ? AlertTriangle : Clock;

    return (
      <div
        className="flex items-center justify-between gap-3 px-4 py-2.5 text-xs font-medium"
        style={{ background: bg, borderBottom: `1px solid ${color}22`, color }}
      >
        <div className="flex items-center gap-2 min-w-0">
          <Icon size={13} className="flex-shrink-0" />
          <span>
            {urgent
              ? tPlural({ one: 'trial.urgent.one', other: 'trial.urgent.other' }, days)
              : warning
                ? t('trial.warning', { count: days })
                : tPlural({ one: 'trial.active.one', other: 'trial.active.other' }, days)
            }
          </span>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <a
            href="mailto:support@el-professor.de?subject=Plan upgraden"
            className="flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-semibold transition-opacity hover:opacity-80"
            style={{ background: fill, color: 'white' }}
          >
            <Zap size={10} />
            {t('trial.choosePlan')}
          </a>
          <button
            onClick={() => setDismissed(true)}
            className="p-0.5 rounded transition-opacity hover:opacity-60"
            style={{ color }}
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
      <div
        className="flex items-center justify-between gap-3 px-4 py-2.5 text-xs font-medium"
        style={{ background: 'var(--danger-subtle)', borderBottom: '1px solid var(--danger)', color: 'var(--danger)' }}
      >
        <div className="flex items-center gap-2">
          <AlertTriangle size={13} className="flex-shrink-0" />
          <span>
            {t('trial.expired')}
          </span>
        </div>
        <a
          href="mailto:support@el-professor.de?subject=Plan upgraden"
          className="flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-semibold flex-shrink-0 transition-opacity hover:opacity-80"
          style={{ background: 'var(--danger-solid)', color: 'white' }}
        >
          <Zap size={10} />
          Plan wählen
        </a>
      </div>
    );
  }

  return null;
};

export default TrialBanner;
