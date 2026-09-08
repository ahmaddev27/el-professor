import React from 'react';
import { Lock, Zap, ArrowLeft } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Plan, PLAN_RANK } from '../contexts/PlanContext';

interface LockedFeaturePageProps {
  featureName: string;
  requiredPlan: Plan;
}

const PLAN_LABELS: Record<Plan, string> = {
  basic: 'Basic',
  advanced: 'Advanced',
  premium: 'Premium',
};

const PLAN_COLOR: Record<Plan, string> = {
  basic: 'var(--accent)',
  advanced: '#f59e0b',
  premium: '#10b981',
};

const LockedFeaturePage: React.FC<LockedFeaturePageProps> = ({ featureName, requiredPlan }) => {
  const navigate = useNavigate();

  return (
    <div
      className="flex flex-col items-center justify-center min-h-[60vh] text-center px-4"
    >
      <div
        className="w-16 h-16 rounded-2xl flex items-center justify-center mb-5"
        style={{ background: 'var(--bg-muted)' }}
      >
        <Lock size={28} style={{ color: 'var(--text-tertiary)' }} />
      </div>

      <h2 className="text-xl font-bold mb-2" style={{ color: 'var(--text-primary)' }}>
        {featureName} ist nicht in Ihrem Plan
      </h2>

      <p className="text-sm mb-6 max-w-sm leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
        Dieses Modul ist ab dem{' '}
        <span
          className="font-semibold px-1.5 py-0.5 rounded-md"
          style={{
            background: `${PLAN_COLOR[requiredPlan]}20`,
            color: PLAN_COLOR[requiredPlan],
          }}
        >
          {PLAN_LABELS[requiredPlan]}-Plan
        </span>{' '}
        verfügbar. Kontaktieren Sie uns um Ihren Plan zu upgraden.
      </p>

      <div className="flex items-center gap-3">
        <button
          onClick={() => navigate('/overview')}
          className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium transition-colors"
          style={{ border: '1px solid var(--border)', color: 'var(--text-secondary)' }}
          onMouseEnter={e => ((e.currentTarget as HTMLElement).style.background = 'var(--bg-muted)')}
          onMouseLeave={e => ((e.currentTarget as HTMLElement).style.background = 'transparent')}
        >
          <ArrowLeft size={14} />
          Zurück zur Übersicht
        </button>

        <a
          href="mailto:support@el-professor.de?subject=Plan upgraden"
          className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold transition-opacity hover:opacity-85"
          style={{ background: PLAN_COLOR[requiredPlan], color: 'white' }}
        >
          <Zap size={14} />
          Plan upgraden
        </a>
      </div>

      {/* Plan comparison hint */}
      <div
        className="mt-8 p-4 rounded-2xl text-left max-w-sm w-full"
        style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}
      >
        <p className="text-xs font-semibold uppercase tracking-wider mb-3" style={{ color: 'var(--text-tertiary)' }}>
          Verfügbar im {PLAN_LABELS[requiredPlan]}-Plan
        </p>
        {requiredPlan === 'advanced' && (
          <ul className="space-y-1.5 text-sm" style={{ color: 'var(--text-secondary)' }}>
            {['Werkstatt', 'Abrechnung', 'Notizen', 'Rollen & Nutzer', 'Benachrichtigungen'].map(f => (
              <li key={f} className="flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: PLAN_COLOR.advanced }} />
                {f}
              </li>
            ))}
          </ul>
        )}
        {requiredPlan === 'premium' && (
          <ul className="space-y-1.5 text-sm" style={{ color: 'var(--text-secondary)' }}>
            {['Gehälter', 'Trinkgeld Quittung', 'Stundennachweis', '+ alle Advanced-Features'].map(f => (
              <li key={f} className="flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: PLAN_COLOR.premium }} />
                {f}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
};

export default LockedFeaturePage;
