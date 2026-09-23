import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { useSuperAdmin } from '../contexts/SuperAdminContext';
import { subscriptionIsActive } from '../utils/planState';
import {
  CheckCircle, XCircle, CalendarDays, RefreshCw, KeyRound,
  Clock, ShieldCheck, History, AlertCircle,
} from 'lucide-react';
import { format, differenceInDays } from 'date-fns';
import { de } from 'date-fns/locale';
import { useTranslation } from '../contexts/LanguageContext';
import type { TranslationKey } from '../i18n';
import { Alert, Badge, Button, Card, DataTable, EmptyState, PageHeader, cn, type DataTableColumn } from '../components/ui';

// Map keys are the stored `subscription_duration_type` values and must not be
// translated; the values hold a TranslationKey because t() is a hook value and
// this map is module-level. Every consumer resolves it.
const DURATION_LABELS: Record<string, TranslationKey> = {
  '1_monat':           'sa.billing.duration.oneMonth',
  '3_monate':          'sa.billing.duration.threeMonths',
  '1_jahr':            'sa.billing.duration.oneYear',
  'benutzerdefiniert': 'sa.billing.duration.custom',
};

interface CompanySubDetail {
  subscription_started_at: string | null;
  subscription_duration_type: string | null;
  last_activation_code_id: string | null;
  /*
    Read here as well as in AuthContext since 3.4b: inside a support session
    AuthContext holds the *staff account's* subscription facts, which are null,
    while this screen is about the company that was opened. Both columns are
    derived by `recompute_company_subscription` (20260919150000) and judged by
    `subscriptionIsActive()`, the one place the browser spells that rule.
  */
  subscription_status: string | null;
  subscription_expires_at: string | null;
}

interface ActivationHistoryRow {
  id: string;
  code_last4: string | null;
  duration_type: string | null;
  used_at: string | null;
  status: string;
  applied_subscription_started_at: string | null;
  applied_subscription_expires_at: string | null;
}

function fmtDate(iso: string | null | undefined) {
  if (!iso) return '—';
  try { return format(new Date(iso), 'dd.MM.yyyy', { locale: de }); } catch { return '—'; }
}

export default function CompanyBillingPage() {
  const {
    subscriptionExpiresAt: ownExpiresAt,
    isSubscriptionActive: ownIsActive,
    effectiveSubscriptionStatus: ownStatus,
  } = useAuth();
  // The company the session is in (plan 3.4b). For a company user that is its
  // own; inside a support session it is the company that was opened, and the
  // three figures above are then the wrong company's — see `subActive` below.
  const { effectiveCompanyId: companyId, companyScope } = useSuperAdmin();
  const navigate = useNavigate();
  const { t, tPlural } = useTranslation();

  const [companyDetail, setCompanyDetail] = useState<CompanySubDetail | null>(null);
  const [lastCodeLast4, setLastCodeLast4] = useState<string | null>(null);
  const [history, setHistory] = useState<ActivationHistoryRow[]>([]);
  const [loading, setLoading] = useState(true);

  const loadData = useCallback(async () => {
    if (!companyId) return;
    setLoading(true);
    try {
      const [detailRes, histRes] = await Promise.all([
        supabase
          .from('companies')
          .select('subscription_started_at, subscription_duration_type, last_activation_code_id, subscription_status, subscription_expires_at')
          .eq('id', companyId)
          .maybeSingle(),
        supabase
          .from('activation_codes')
          .select('id, code_last4, duration_type, used_at, status, applied_subscription_started_at, applied_subscription_expires_at')
          .eq('used_company_id', companyId)
          .eq('status', 'used')
          .is('hidden_at', null)
          .is('deleted_at', null)
          .order('used_at', { ascending: false }),
      ]);

      const detail = detailRes.data as CompanySubDetail | null;
      setCompanyDetail(detail);
      if (histRes.data) setHistory(histRes.data as ActivationHistoryRow[]);

      if (detail?.last_activation_code_id) {
        const match = (histRes.data as ActivationHistoryRow[] | null)?.find(
          r => r.id === detail.last_activation_code_id
        );
        if (match) {
          setLastCodeLast4(match.code_last4);
        } else {
          const { data: codeRow } = await supabase
            .from('activation_codes')
            .select('code_last4')
            .eq('id', detail.last_activation_code_id)
            .maybeSingle();
          setLastCodeLast4((codeRow as { code_last4: string | null } | null)?.code_last4 ?? null);
        }
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [companyId]);

  useEffect(() => { loadData(); }, [loadData]);

  /*
    Whose subscription this screen is about.

    A company user's own, from AuthContext, exactly as before. Inside a support
    session the opened company's, from the row this screen just read — the
    account's own facts are null there, which printed "kein aktives Abo" over a
    paying customer's own activation history. The predicate is
    `subscriptionIsActive()` either way, the same function AuthContext and
    PlanContext ask, so the word on the screen cannot drift from the rule that
    decides access.
  */
  const inSupportSession = companyScope.isPlatformSession;
  const subscriptionExpiresAt = inSupportSession
    ? companyDetail?.subscription_expires_at ?? null
    : ownExpiresAt;
  const subActive = inSupportSession
    ? subscriptionIsActive(companyDetail?.subscription_status, companyDetail?.subscription_expires_at)
    : ownIsActive;
  const subExpired = inSupportSession
    ? companyDetail?.subscription_status === 'active' && !subActive
    : ownStatus === 'expired';
  const subExpiry = subscriptionExpiresAt
    ? (() => { try { return format(new Date(subscriptionExpiresAt), 'dd. MMMM yyyy', { locale: de }); } catch { return null; } })()
    : null;

  const aboStatusLabel =
    subActive ? t('sa.status.active') :
    subExpired ? t('sa.billing.statusExpired') :
    t('sa.status.inactive');

  const daysRemaining = subActive && subscriptionExpiresAt
    ? differenceInDays(new Date(subscriptionExpiresAt), new Date())
    : null;

  const subStarted = companyDetail?.subscription_started_at
    ? (() => { try { return format(new Date(companyDetail.subscription_started_at), 'dd. MMMM yyyy', { locale: de }); } catch { return null; } })()
    : null;
  const durationKey = companyDetail?.subscription_duration_type
    ? DURATION_LABELS[companyDetail.subscription_duration_type]
    : undefined;
  const durLabel = durationKey
    ? t(durationKey)
    : companyDetail?.subscription_duration_type ?? null;

  const hasHistory = history.length > 0;

  // ── Presentation (phase 5) ────────────────────────────────────────────────
  // Everything above is unchanged: whose subscription this is (the opened
  // company's inside a support session, the account's own otherwise), the
  // rule that judges it, and every date and figure. The two colour picks that
  // sat among them are the tone below, chosen in the same order.

  const aboTone: 'positive' | 'caution' | 'critical' =
    subActive ? 'positive' :
    subExpired ? 'caution' :
    'critical';
  const StatusIcon = subActive ? CheckCircle : subExpired ? AlertCircle : XCircle;

  if (loading) {
    return (
      <div role="status" className="flex items-center justify-center py-24 font-ui">
        <RefreshCw aria-hidden className="size-6 text-brand-text motion-safe:animate-spin" />
        <span className="sr-only">{t('sa.billing.title')}</span>
      </div>
    );
  }

  const activateButton = (
    <Button onClick={() => navigate('/abo-aktivieren')}>
      <KeyRound aria-hidden />
      {t('sa.billing.activateCta')}
    </Button>
  );

  // Each row's state, worked out as the old table body did, from the order
  // the rows were read in — the table below does not sort.
  const historyRows = history.map((row, idx) => {
    const isCurrentActive = subActive && idx === 0 && companyDetail?.last_activation_code_id === row.id;
    const appliedExpiry = row.applied_subscription_expires_at;
    const isPastPeriod = appliedExpiry ? new Date(appliedExpiry) <= new Date() : false;
    return { row, isCurrentActive, isPastPeriod };
  });
  type HistoryRow = (typeof historyRows)[number];

  const historyColumns: DataTableColumn<HistoryRow>[] = [
    {
      id: 'date',
      header: t('common.date'),
      cell: ({ row }) => (
        <span className="whitespace-nowrap font-medium tabular-nums">
          {row.used_at
            ? (() => { try { return format(new Date(row.used_at), 'dd.MM.yyyy HH:mm', { locale: de }); } catch { return '-'; } })()
            : '-'}
        </span>
      ),
    },
    {
      id: 'type',
      header: t('sa.billing.col.type'),
      cell: () => <span className="whitespace-nowrap text-fg-muted">{t('sa.billing.rowTypeCash')}</span>,
    },
    {
      id: 'duration',
      header: t('sa.billing.col.duration'),
      cell: ({ row }) => (
        <span className="whitespace-nowrap text-fg-muted">
          {row.duration_type
            ? (DURATION_LABELS[row.duration_type] ? t(DURATION_LABELS[row.duration_type]) : row.duration_type)
            : '-'}
        </span>
      ),
    },
    {
      id: 'from',
      header: t('sa.billing.col.activeFrom'),
      cell: ({ row }) => <span className="whitespace-nowrap tabular-nums text-fg-muted">{fmtDate(row.applied_subscription_started_at)}</span>,
    },
    {
      id: 'to',
      header: t('sa.billing.col.activeTo'),
      cell: ({ row, isPastPeriod }) => (
        <span className={cn('whitespace-nowrap font-medium tabular-nums', isPastPeriod ? 'text-caution' : 'text-fg')}>
          {fmtDate(row.applied_subscription_expires_at)}
        </span>
      ),
    },
    {
      id: 'code',
      header: t('sa.billing.col.code'),
      cell: ({ row }) => (
        <span className="font-mono text-xs tracking-widest text-fg-subtle">
          {row.code_last4 ? `••${row.code_last4}` : '••••'}
        </span>
      ),
    },
    {
      id: 'status',
      header: t('common.status'),
      cell: ({ isCurrentActive, isPastPeriod }) => {
        if (isCurrentActive) {
          return <Badge tone="positive"><CheckCircle aria-hidden />{t('sa.billing.rowCurrentlyActive')}</Badge>;
        } else if (isPastPeriod) {
          return <Badge tone="caution"><Clock aria-hidden />{t('sa.billing.statusExpired')}</Badge>;
        } else {
          return <Badge tone="brand"><CheckCircle aria-hidden />{t('sa.billing.rowUsed')}</Badge>;
        }
      },
    },
  ];

  const detail = (label: string, value: React.ReactNode, tone?: string) => (
    <div>
      <dt className="mb-1 text-xs font-medium text-fg-muted">{label}</dt>
      <dd className={cn('text-sm font-medium tabular-nums', tone ?? 'text-fg')}>{value}</dd>
    </div>
  );

  return (
    <div className="grid grid-cols-1 gap-6 font-ui">
      <PageHeader title={t('sa.billing.title')} className="pb-0" />

      {/* Abo Status Header Card */}
      <Card className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-4">
            <span
              aria-hidden
              className={cn(
                'flex size-11 shrink-0 items-center justify-center rounded-surface',
                aboTone === 'positive' ? 'bg-positive-soft text-positive' : aboTone === 'caution' ? 'bg-caution-soft text-caution' : 'bg-critical-soft text-critical',
              )}
            >
              <ShieldCheck className="size-5" />
            </span>
            <div className="min-w-0">
              <p className="mb-1 text-xs font-medium text-fg-muted">{t('sa.billing.statusLabel')}</p>
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={aboTone}>
                  <StatusIcon aria-hidden />
                  {aboStatusLabel}
                </Badge>
                {subActive && subExpiry && (
                  <span className="flex flex-wrap items-center gap-1.5 text-sm text-fg-muted">
                    <CalendarDays aria-hidden className="size-3.5 text-positive" />
                    {t('sa.billing.activeUntilColon')}
                    <span className="font-semibold text-fg">{subExpiry}</span>
                    {daysRemaining !== null && (
                      <Badge tone={daysRemaining <= 7 ? 'caution' : 'positive'}>
                        {tPlural({ one: 'sa.billing.dayCount.one', other: 'sa.billing.dayCount.other' }, daysRemaining)}
                      </Badge>
                    )}
                  </span>
                )}
                {subExpired && subExpiry && (
                  <span className="flex flex-wrap items-center gap-1.5 text-sm text-fg-muted">
                    <CalendarDays aria-hidden className="size-3.5 text-caution" />
                    {t('sa.billing.expiredOnColon')}
                    <span className="font-semibold text-caution">{subExpiry}</span>
                  </span>
                )}
              </div>
            </div>
          </div>
          {!subActive && activateButton}
        </div>
      </Card>

      {/* Active subscription detail */}
      {subActive && (
        <Card className="grid gap-4 p-5 sm:p-6">
          <div className="flex items-center gap-3">
            <span aria-hidden className="flex size-10 shrink-0 items-center justify-center rounded-surface bg-positive-soft text-positive">
              <CheckCircle className="size-[18px]" />
            </span>
            <div>
              <h2 className="font-semibold text-fg">{t('sa.billing.activeSubTitle')}</h2>
              <p className="mt-0.5 text-xs text-fg-muted">{t('sa.billing.activeSubSub')}</p>
            </div>
          </div>
          <dl className="grid grid-cols-2 gap-4 pt-1 sm:grid-cols-4">
            {subStarted && detail(t('sa.billing.startedOn'), subStarted)}
            {subExpiry && detail(t('sa.billing.activeUntil'), subExpiry)}
            {durLabel && detail(t('sa.billing.term'), durLabel)}
            {lastCodeLast4 && detail(t('sa.billing.activationCode'), <span className="font-mono tracking-widest">••{lastCodeLast4}</span>)}
            {daysRemaining !== null && detail(
              t('sa.billing.remainingTerm'),
              tPlural({ one: 'sa.billing.dayCount.one', other: 'sa.billing.dayCount.other' }, daysRemaining),
              cn('font-semibold', daysRemaining <= 7 ? 'text-caution' : 'text-positive'),
            )}
          </dl>
        </Card>
      )}

      {/* Expired state */}
      {!subActive && subExpired && (
        <Card className="p-6">
          <EmptyState
            size="sm"
            icon={AlertCircle}
            title={t('sa.billing.expiredTitle')}
            description={t('sa.billing.expiredSub')}
            action={activateButton}
          />
        </Card>
      )}

      {/* Inactive state (no history) */}
      {!subActive && !subExpired && !hasHistory && (
        <Card className="p-6">
          <EmptyState
            size="sm"
            icon={XCircle}
            title={t('sa.billing.noneTitle')}
            description={t('sa.billing.noneSub')}
            action={activateButton}
          />
        </Card>
      )}

      {/* Inactive with previous history — show note but don't hide history */}
      {!subActive && !subExpired && hasHistory && (
        <Alert tone="critical" role="status" icon={XCircle} title={t('sa.billing.noneTitle')}>
          {t('sa.billing.inactiveWithHistory')}
        </Alert>
      )}

      {/* Activation history */}
      <section className="grid gap-3">
        <h2 className="flex items-center gap-2 text-lg font-semibold text-fg">
          <History aria-hidden className="size-4 text-fg-subtle" />
          {t('sa.billing.historyTitle')}
        </h2>
        {history.length === 0 ? (
          <Card>
            <EmptyState size="sm" icon={Clock} title={t('sa.billing.historyEmpty')} />
          </Card>
        ) : (
          <DataTable
            caption={t('sa.billing.historyTitle')}
            columns={historyColumns}
            rows={historyRows}
            getRowId={({ row }) => row.id}
            density="compact"
          />
        )}
      </section>
    </div>
  );
}
