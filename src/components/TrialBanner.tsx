import React, { useState } from 'react';
import { X, Clock, Zap, AlertTriangle } from 'lucide-react';
import { usePlan } from '../contexts/PlanContext';

const TrialBanner: React.FC = () => {
  const { planState } = usePlan();
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
              ? `Nur noch ${days} Tag${days === 1 ? '' : 'e'} in Ihrer kostenlosen Testphase — jetzt upgraden um den Zugang zu behalten.`
              : warning
                ? `Ihre Testphase endet in ${days} Tagen. Wählen Sie einen Plan um weiterzumachen.`
                : `Testphase aktiv — ${days} Tag${days === 1 ? '' : 'e'} verbleiben. Alle Premium-Features freigeschaltet.`
            }
          </span>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <a
            href="mailto:support@el-professor.de?subject=Plan upgraden"
            className="flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-semibold transition-opacity hover:opacity-80"
            style={{ background: color, color: 'white' }}
          >
            <Zap size={10} />
            Plan wählen
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
            Ihre Testphase ist abgelaufen. Advanced- und Premium-Features sind nicht mehr verfügbar.
            Bitte wählen Sie einen Plan um den vollen Zugriff wiederherzustellen.
          </span>
        </div>
        <a
          href="mailto:support@el-professor.de?subject=Plan upgraden"
          className="flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-semibold flex-shrink-0 transition-opacity hover:opacity-80"
          style={{ background: 'var(--danger)', color: 'white' }}
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
