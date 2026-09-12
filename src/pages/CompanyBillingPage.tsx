import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';
import {
  CheckCircle, XCircle, CalendarDays, RefreshCw, KeyRound,
  Clock, ShieldCheck, History, AlertCircle,
} from 'lucide-react';
import { format, differenceInDays } from 'date-fns';
import { de } from 'date-fns/locale';
import { useTranslation } from '../contexts/LanguageContext';
import type { TranslationKey } from '../i18n';

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
    companyId,
    subscriptionExpiresAt,
    isSubscriptionActive,
    effectiveSubscriptionStatus,
  } = useAuth();
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
          .select('subscription_started_at, subscription_duration_type, last_activation_code_id')
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

  const subActive = isSubscriptionActive;
  const subExpired = effectiveSubscriptionStatus === 'expired';
  const subExpiry = subscriptionExpiresAt
    ? (() => { try { return format(new Date(subscriptionExpiresAt), 'dd. MMMM yyyy', { locale: de }); } catch { return null; } })()
    : null;

  const aboStatusColor =
    subActive ? 'var(--success)' :
    subExpired ? 'var(--warning)' :
    'var(--danger)';
  const aboStatusBg =
    subActive ? 'rgba(34,197,94,0.10)' :
    subExpired ? 'rgba(245,158,11,0.10)' :
    'rgba(239,68,68,0.10)';
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

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24">
        <RefreshCw size={24} className="animate-spin" style={{ color: 'var(--accent)' }} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>{t('sa.billing.title')}</h1>

      {/* Abo Status Header Card */}
      <div className="rounded-xl p-5" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}>
        <div className="flex items-center justify-between flex-wrap gap-4">
          <div className="flex items-center gap-4">
            <div className="w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: aboStatusBg }}>
              <ShieldCheck size={20} style={{ color: aboStatusColor }} />
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider mb-1" style={{ color: 'var(--text-tertiary)' }}>{t('sa.billing.statusLabel')}</p>
              <div className="flex items-center gap-2 flex-wrap">
                <span
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold"
                  style={{ background: aboStatusBg, color: aboStatusColor }}
                >
                  {subActive ? <CheckCircle size={11} /> : subExpired ? <AlertCircle size={11} /> : <XCircle size={11} />}
                  {aboStatusLabel}
                </span>
                {subActive && subExpiry && (
                  <span className="flex items-center gap-1.5 text-sm" style={{ color: 'var(--text-secondary)' }}>
                    <CalendarDays size={13} style={{ color: 'var(--success)' }} />
                    {t('sa.billing.activeUntilColon')}
                    <span className="font-semibold" style={{ color: 'var(--text-primary)' }}>{subExpiry}</span>
                    {daysRemaining !== null && (
                      <span
                        className="text-xs px-1.5 py-0.5 rounded-md font-medium"
                        style={{
                          background: daysRemaining <= 7 ? 'var(--warning-subtle)' : 'rgba(34,197,94,0.10)',
                          color: daysRemaining <= 7 ? 'var(--warning)' : 'var(--success)',
                        }}
                      >
                        {tPlural({ one: 'sa.billing.dayCount.one', other: 'sa.billing.dayCount.other' }, daysRemaining)}
                      </span>
                    )}
                  </span>
                )}
                {subExpired && subExpiry && (
                  <span className="flex items-center gap-1.5 text-sm" style={{ color: 'var(--text-secondary)' }}>
                    <CalendarDays size={13} style={{ color: 'var(--warning)' }} />
                    {t('sa.billing.expiredOnColon')}
                    <span className="font-semibold" style={{ color: 'var(--warning)' }}>{subExpiry}</span>
                  </span>
                )}
              </div>
            </div>
          </div>
          {!subActive && (
            <button
              onClick={() => navigate('/abo-aktivieren')}
              className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold transition-all hover:-translate-y-0.5 hover:shadow-[0_4px_16px_rgba(6,182,212,0.3)]"
              style={{ background: 'linear-gradient(135deg, #06b6d4, #3b82f6)', color: '#fff' }}
            >
              <KeyRound size={14} />
              {t('sa.billing.activateCta')}
            </button>
          )}
        </div>
      </div>

      {/* Active subscription detail */}
      {subActive && (
        <div className="rounded-xl p-6 space-y-4" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
              style={{ background: 'rgba(34,197,94,0.10)' }}>
              <CheckCircle size={18} style={{ color: 'var(--success)' }} />
            </div>
            <div>
              <h2 className="font-semibold" style={{ color: 'var(--text-primary)' }}>{t('sa.billing.activeSubTitle')}</h2>
              <p className="text-xs mt-0.5" style={{ color: 'var(--text-secondary)' }}>{t('sa.billing.activeSubSub')}</p>
            </div>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 pt-1">
            {subStarted && (
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider mb-1" style={{ color: 'var(--text-tertiary)' }}>{t('sa.billing.startedOn')}</p>
                <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{subStarted}</p>
              </div>
            )}
            {subExpiry && (
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider mb-1" style={{ color: 'var(--text-tertiary)' }}>{t('sa.billing.activeUntil')}</p>
                <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{subExpiry}</p>
              </div>
            )}
            {durLabel && (
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider mb-1" style={{ color: 'var(--text-tertiary)' }}>{t('sa.billing.term')}</p>
                <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{durLabel}</p>
              </div>
            )}
            {lastCodeLast4 && (
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider mb-1" style={{ color: 'var(--text-tertiary)' }}>{t('sa.billing.activationCode')}</p>
                <p className="text-sm font-mono font-medium tracking-widest" style={{ color: 'var(--text-primary)' }}>
                  ••{lastCodeLast4}
                </p>
              </div>
            )}
            {daysRemaining !== null && (
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider mb-1" style={{ color: 'var(--text-tertiary)' }}>{t('sa.billing.remainingTerm')}</p>
                <p
                  className="text-sm font-semibold"
                  style={{ color: daysRemaining <= 7 ? 'var(--warning)' : 'var(--success)' }}
                >
                  {tPlural({ one: 'sa.billing.dayCount.one', other: 'sa.billing.dayCount.other' }, daysRemaining)}
                </p>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Expired state */}
      {!subActive && subExpired && (
        <div className="rounded-xl p-6 text-center space-y-3" style={{ background: 'var(--bg-surface)', border: '1px solid rgba(245,158,11,0.3)' }}>
          <div className="w-14 h-14 rounded-full flex items-center justify-center mx-auto"
            style={{ background: 'rgba(245,158,11,0.10)', border: '1px solid rgba(245,158,11,0.25)' }}>
            <AlertCircle size={26} style={{ color: 'var(--warning)' }} />
          </div>
          <p className="font-semibold" style={{ color: 'var(--text-primary)' }}>{t('sa.billing.expiredTitle')}</p>
          <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>
            {t('sa.billing.expiredSub')}
          </p>
          <button
            onClick={() => navigate('/abo-aktivieren')}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold transition-all hover:-translate-y-0.5 hover:shadow-[0_4px_16px_rgba(6,182,212,0.3)] mt-1"
            style={{ background: 'linear-gradient(135deg, #06b6d4, #3b82f6)', color: '#fff' }}
          >
            <KeyRound size={14} />
            {t('sa.billing.activateCta')}
          </button>
        </div>
      )}

      {/* Inactive state (no history) */}
      {!subActive && !subExpired && !hasHistory && (
        <div className="rounded-xl p-8 text-center space-y-3" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}>
          <div className="w-14 h-14 rounded-full flex items-center justify-center mx-auto"
            style={{ background: 'rgba(239,68,68,0.10)', border: '1px solid rgba(239,68,68,0.2)' }}>
            <XCircle size={26} style={{ color: 'var(--danger)' }} />
          </div>
          <p className="font-semibold" style={{ color: 'var(--text-primary)' }}>{t('sa.billing.noneTitle')}</p>
          <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>
            {t('sa.billing.noneSub')}
          </p>
          <button
            onClick={() => navigate('/abo-aktivieren')}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold transition-all hover:-translate-y-0.5 hover:shadow-[0_4px_16px_rgba(6,182,212,0.3)] mt-1"
            style={{ background: 'linear-gradient(135deg, #06b6d4, #3b82f6)', color: '#fff' }}
          >
            <KeyRound size={14} />
            {t('sa.billing.activateCta')}
          </button>
        </div>
      )}

      {/* Inactive with previous history — show note but don't hide history */}
      {!subActive && !subExpired && hasHistory && (
        <div className="rounded-xl p-4 flex items-start gap-3" style={{ background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.2)' }}>
          <XCircle size={16} style={{ color: 'var(--danger)', flexShrink: 0, marginTop: 1 }} />
          <div>
            <p className="text-sm font-semibold" style={{ color: 'var(--danger)' }}>{t('sa.billing.noneTitle')}</p>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-secondary)' }}>
              {t('sa.billing.inactiveWithHistory')}
            </p>
          </div>
        </div>
      )}

      {/* Activation history */}
      <div>
        <div className="flex items-center gap-2 mb-3">
          <History size={16} style={{ color: 'var(--text-tertiary)' }} />
          <h2 className="text-lg font-bold" style={{ color: 'var(--text-primary)' }}>{t('sa.billing.historyTitle')}</h2>
        </div>
        {history.length === 0 ? (
          <div className="rounded-xl p-8 text-center" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}>
            <Clock size={32} className="mx-auto mb-2 opacity-30" style={{ color: 'var(--text-tertiary)' }} />
            <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>{t('sa.billing.historyEmpty')}</p>
          </div>
        ) : (
          <div className="rounded-xl overflow-hidden" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border)' }}>
                    {([
                      'common.date', 'sa.billing.col.type', 'sa.billing.col.duration',
                      'sa.billing.col.activeFrom', 'sa.billing.col.activeTo',
                      'sa.billing.col.code', 'common.status',
                    ] as const).map((h, i) => (
                      <th
                        key={i}
                        className="text-left px-4 py-3 text-xs font-semibold uppercase tracking-wider"
                        style={{ color: 'var(--text-tertiary)' }}
                      >
                        {t(h)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {history.map((row, idx) => {
                    const isCurrentActive = subActive && idx === 0 && companyDetail?.last_activation_code_id === row.id;
                    const appliedExpiry = row.applied_subscription_expires_at;
                    const isPastPeriod = appliedExpiry ? new Date(appliedExpiry) <= new Date() : false;

                    let rowStatus: React.ReactNode;
                    if (isCurrentActive) {
                      rowStatus = (
                        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold"
                          style={{ background: 'rgba(34,197,94,0.12)', color: 'var(--success)' }}>
                          <CheckCircle size={11} />{t('sa.billing.rowCurrentlyActive')}
                        </span>
                      );
                    } else if (isPastPeriod) {
                      rowStatus = (
                        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold"
                          style={{ background: 'rgba(245,158,11,0.10)', color: 'var(--warning)' }}>
                          <Clock size={11} />{t('sa.billing.statusExpired')}
                        </span>
                      );
                    } else {
                      rowStatus = (
                        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold"
                          style={{ background: 'rgba(6,182,212,0.10)', color: 'var(--accent)' }}>
                          <CheckCircle size={11} />{t('sa.billing.rowUsed')}
                        </span>
                      );
                    }

                    return (
                      <tr
                        key={row.id}
                        className="transition-colors"
                        style={{ borderBottom: '1px solid var(--border)' }}
                        onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-muted)')}
                        onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                      >
                        <td className="px-4 py-3 font-medium whitespace-nowrap" style={{ color: 'var(--text-primary)' }}>
                          {row.used_at
                            ? (() => { try { return format(new Date(row.used_at), 'dd.MM.yyyy HH:mm', { locale: de }); } catch { return '-'; } })()
                            : '-'}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>
                          {t('sa.billing.rowTypeCash')}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap" style={{ color: 'var(--text-secondary)' }}>
                          {row.duration_type
                            ? (DURATION_LABELS[row.duration_type] ? t(DURATION_LABELS[row.duration_type]) : row.duration_type)
                            : '-'}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap text-xs" style={{ color: 'var(--text-secondary)' }}>
                          {fmtDate(row.applied_subscription_started_at)}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap text-xs font-medium"
                          style={{ color: isPastPeriod ? 'var(--warning)' : 'var(--text-primary)' }}>
                          {fmtDate(row.applied_subscription_expires_at)}
                        </td>
                        <td className="px-4 py-3 font-mono text-xs tracking-widest" style={{ color: 'var(--text-tertiary)' }}>
                          {row.code_last4 ? `••${row.code_last4}` : '••••'}
                        </td>
                        <td className="px-4 py-3">
                          {rowStatus}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
