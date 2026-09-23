import { AlertOctagon, AlertTriangle, CheckCircle2, CircleDashed, HelpCircle, Info, RefreshCw, ShieldCheck } from 'lucide-react';
import { Badge } from '../ui';
import { useTranslation } from '../../contexts/LanguageContext';
import type { IssueSeverity, IssueStatus, TripStatus } from '../../utils/tripAnalysis/types';
import type { BudgetState } from '../../lib/tripAnalysisView';
import { ISSUE_SEVERITY_KEYS, ISSUE_STATUS_KEYS, TRIP_STATUS_KEYS } from '../../lib/tripAnalysisLabels';

/**
 * The three statuses of a finding, each with its own word and icon: colour is
 * never the only signal, and "nicht prüfbar" is a state of its own, not a
 * softer conflict.
 */
export function IssueStatusBadge({ status }: { status: IssueStatus }) {
  const { t } = useTranslation();
  if (status === 'conflict') {
    return (
      <Badge tone="critical">
        <AlertOctagon aria-hidden />
        {t(ISSUE_STATUS_KEYS.conflict)}
      </Badge>
    );
  }
  if (status === 'unverifiable') {
    return (
      <Badge tone="caution">
        <HelpCircle aria-hidden />
        {t(ISSUE_STATUS_KEYS.unverifiable)}
      </Badge>
    );
  }
  return (
    <Badge tone="positive">
      <CheckCircle2 aria-hidden />
      {t(ISSUE_STATUS_KEYS.passed)}
    </Badge>
  );
}

export function SeverityBadge({ severity }: { severity: IssueSeverity }) {
  const { t } = useTranslation();
  const tone = severity === 'error' ? 'critical' : severity === 'warning' ? 'caution' : 'neutral';
  const Icon = severity === 'info' ? Info : AlertTriangle;
  return (
    <Badge tone={tone}>
      <Icon aria-hidden />
      {t(ISSUE_SEVERITY_KEYS[severity])}
    </Badge>
  );
}

export function BudgetStateBadge({ state }: { state: BudgetState }) {
  const { t } = useTranslation();
  if (state === 'confirmed') {
    return (
      <Badge tone="positive">
        <ShieldCheck aria-hidden />
        {t('ta.budget.confirmed')}
      </Badge>
    );
  }
  if (state === 'inputs_changed') {
    return (
      <Badge tone="caution">
        <RefreshCw aria-hidden />
        {t('ta.budget.inputsChanged')}
      </Badge>
    );
  }
  return (
    <Badge tone="neutral">
      <CircleDashed aria-hidden />
      {t('ta.budget.notConfirmed')}
    </Badge>
  );
}

export function TripStatusBadge({ status }: { status: TripStatus }) {
  const { t } = useTranslation();
  const tone = status === 'completed' ? 'neutral' : status === 'cancelled' ? 'neutral' : 'caution';
  return <Badge tone={tone}>{t(TRIP_STATUS_KEYS[status])}</Badge>;
}
