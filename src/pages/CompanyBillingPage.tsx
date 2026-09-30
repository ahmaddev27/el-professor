import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import { useSuperAdmin } from '../contexts/SuperAdminContext';
import { subscriptionIsActive } from '../utils/planState';
import {
  CheckCircle, XCircle, CalendarDays, RefreshCw, KeyRound,
  Clock, ShieldCheck, History, AlertCircle,
  type LucideIcon,
} from 'lucide-react';
import { format, differenceInDays } from 'date-fns';
import { de } from 'date-fns/locale';
import { useTranslation } from '../contexts/LanguageContext';
import type { TranslationKey } from '../i18n';
import { Alert, Badge, Button, Card, DataTable, EmptyState, PageHeader, cn, type DataTableColumn } from '../components/ui';
import {
  coverageHistory,
  parseCoverageRows,
  type CoverageEntry,
  type CoverageSource,
  type CoverageState,
} from '../lib/companyCoverageHistory';

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

/*
  The five sources of a coverage period, as labels. Keys are the stored
  `subscription_coverage.source` values and must not be translated; the values
  hold a TranslationKey because t() is a hook value and this map is
  module-level.
*/
const SOURCE_LABELS: Record<CoverageSource, TranslationKey> = {
  invoice:         'sa.billing.source.invoice',
  activation_code: 'sa.billing.source.activationCode',
  manual:          'sa.billing.source.manual',
  trial:           'sa.billing.source.trial',
  migration:       'sa.billing.source.migration',
};

/* The badge each period state gets. Same order as CoverageState's own. */
const STATE_LABELS: Record<CoverageState, TranslationKey> = {
  withdrawn: 'sa.billing.rowWithdrawn',
  blocked:   'sa.billing.rowBlocked',
  future:    'sa.billing.rowFuture',
  current:   'sa.billing.rowCurrentlyActive',
  past:      'sa.billing.statusExpired',
};

const STATE_TONES: Record<CoverageState, 'positive' | 'caution' | 'neutral' | 'brand'> = {
  withdrawn: 'neutral',
  blocked:   'caution',
  future:    'brand',
  current:   'positive',
  past:      'caution',
};

/* Colour is never the only signal, so every state carries its own icon too. */
const STATE_ICONS: Record<CoverageState, LucideIcon> = {
  withdrawn: XCircle,
  blocked:   AlertCircle,
  future:    CalendarDays,
  current:   CheckCircle,
  past:      Clock,
};

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
  const [history, setHistory] = useState<CoverageEntry[]>([]);
  const [loading, setLoading] = useState(true);
  /**
   * A read that did not succeed. Neither the Abo-Status card nor the history is
   * drawn while it is set: "kein aktives Abonnement" and "noch keine
   * Zeiträume" are both claims, and a read that failed makes neither.
   */
  const [loadFailed, setLoadFailed] = useState(false);

  const loadData = useCallback(async () => {
    if (!companyId) return;
    setLoading(true);
    setLoadFailed(false);
    try {
      const [detailRes, histRes] = await Promise.all([
        supabase
          .from('companies')
          .select('subscription_started_at, subscription_duration_type, last_activation_code_id, subscription_status, subscription_expires_at')
          .eq('id', companyId)
          .maybeSingle(),
        /*
          The history is `subscription_coverage`, not `activation_codes`.

          `activation_codes` is gated on `platform_can('codes.manage')` with no
          tenant term, so a company role was *filtered* to zero rows — no error,
          no refusal, just an empty list under the heading "Zahlungs- &
          Aktivierungshistorie". `subscription_coverage` is keyed on
          `get_user_company_id()`, the caller's own company (and, for a
          company-less platform account, the company its context names), so an
          empty answer here honestly means no periods were recorded. See the
          header of src/lib/companyCoverageHistory.ts.

          Every source is shown, not only `activation_code`: a customer billed by
          invoice has the same right to the Zahlungs- half of the heading.
        */
        supabase
          .from('subscription_coverage')
          .select('id, source, period_start, period_end, grants_access, status, created_at')
          .eq('company_id', companyId)
          .order('period_start', { ascending: false }),
      ]);

      if (detailRes.error) throw detailRes.error;
      if (histRes.error) throw histRes.error;

      const detail = detailRes.data as CompanySubDetail | null;
      setCompanyDetail(detail);
      setHistory(coverageHistory(parseCoverageRows(histRes.data), new Date()));

      if (detail?.last_activation_code_id) {
        /*
          Best effort, and deliberately not part of the failure above: this row
          resolves only for a caller holding `codes.manage` (an owner inside a
          support session). A company role reads nothing here, `lastCodeLast4`
          stays null, and the field is then *omitted* from the card rather than
          printed as "••••" — so no claim is made either way, and a refusal here
          must not blank the page.
        */
        const { data: codeRow } = await supabase
          .from('activation_codes')
          .select('code_last4')
          .eq('id', detail.last_activation_code_id)
          .maybeSingle();
        setLastCodeLast4((codeRow as { code_last4: string | null } | null)?.code_last4 ?? null);
      }
    } catch (err) {
      console.error(err);
      setCompanyDetail(null);
      setLastCodeLast4(null);
      setHistory([]);
      setLoadFailed(true);
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

  /*
    Whether there is an Abo-Status to print at all.

    For a company user the three figures come from AuthContext, which this
    screen's own read does not touch — so a failed read here leaves the status
    word intact and only the detail fields (Gestartet am, Laufzeit,
    Restlaufzeit) drop out, each already conditional on the row being there.

    Inside a support session they come from the row that failed. `subActive`
    would then be false and `subExpired` false, and the screen would tell an
    operator "Kein aktives Abonnement" about a company it never managed to
    read — a claim from a read that did not happen.
  */
  const statusKnown = !loadFailed || !inSupportSession;

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

  /*
    Each row's state is `coverageState()`, not a guess from its position in the
    list. The old table decided "Aktuell aktiv" by `idx === 0` plus a match on
    `last_activation_code_id`, which the read it came from could never return to
    a company user anyway; a period now says what it is from its own columns.

    The Laufzeit and Code columns are gone: both lived on `activation_codes`,
    which no company role reads, so they can only be left out — never filled in
    from somewhere else.
  */
  const historyColumns: DataTableColumn<CoverageEntry>[] = [
    {
      id: 'date',
      header: t('common.date'),
      cell: ({ row }) => (
        <span className="whitespace-nowrap font-medium tabular-nums">
          {row.created_at
            ? (() => { try { return format(new Date(row.created_at), 'dd.MM.yyyy HH:mm', { locale: de }); } catch { return '-'; } })()
            : '-'}
        </span>
      ),
    },
    {
      id: 'source',
      header: t('sa.billing.col.source'),
      cell: ({ row }) => (
        <span className="whitespace-nowrap text-fg-muted">
          {row.source ? t(SOURCE_LABELS[row.source]) : (row.sourceRaw || '-')}
        </span>
      ),
    },
    {
      id: 'from',
      header: t('sa.billing.col.activeFrom'),
      cell: ({ row }) => <span className="whitespace-nowrap tabular-nums text-fg-muted">{fmtDate(row.period_start)}</span>,
    },
    {
      id: 'to',
      header: t('sa.billing.col.activeTo'),
      cell: ({ row, state }) => (
        <span className={cn('whitespace-nowrap font-medium tabular-nums', state === 'past' ? 'text-caution' : 'text-fg')}>
          {/* No end means unbefristet, which a dash would deny. */}
          {row.period_end ? fmtDate(row.period_end) : t('sa.billing.openEnded')}
        </span>
      ),
    },
    {
      id: 'status',
      header: t('common.status'),
      cell: ({ state }) => {
        const Icon = STATE_ICONS[state];
        return <Badge tone={STATE_TONES[state]}><Icon aria-hidden />{t(STATE_LABELS[state])}</Badge>;
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

      {/* A read that did not happen: nothing below is drawn from it. */}
      {loadFailed && (
        <Alert tone="critical" title={t('sa.billing.loadFailed')}>
          {t('sa.billing.loadFailedBody')}
        </Alert>
      )}

      {/* Abo Status Header Card */}
      {statusKnown && (
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
      )}

      {/* Active subscription detail */}
      {statusKnown && subActive && (
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
      {statusKnown && !subActive && subExpired && (
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
      {statusKnown && !subActive && !subExpired && !hasHistory && (
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
      {statusKnown && !subActive && !subExpired && hasHistory && (
        <Alert tone="critical" role="status" icon={XCircle} title={t('sa.billing.noneTitle')}>
          {t('sa.billing.inactiveWithHistory')}
        </Alert>
      )}

      {/*
        Payment & activation history. Withheld entirely when the read failed:
        "Noch keine Abo-Zeiträume erfasst" is a statement about the customer's
        payments, and the Alert above already says why there is nothing here.
      */}
      {!loadFailed && (
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
            rows={history}
            getRowId={({ row }) => row.id}
            density="compact"
          />
        )}
      </section>
      )}
    </div>
  );
}
