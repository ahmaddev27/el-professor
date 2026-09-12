import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  KeyRound, CheckCircle2, AlertCircle, RefreshCw,
  CalendarCheck, ArrowLeft, Clock, ShieldCheck,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { supabase } from '../lib/supabase';
import { format, differenceInDays } from 'date-fns';
import { de } from 'date-fns/locale';
import { useTranslation } from '../contexts/LanguageContext';
import type { TranslationKey } from '../i18n';

type SubmitState = 'idle' | 'loading' | 'success' | 'error';

interface CodePreview {
  status: string;
  expires_at: string;
  duration_type: string;
  seconds_remaining: number;
}

// Keys, not text: this map is module-level and t() is a hook value.
const DURATION_LABELS: Record<string, TranslationKey> = {
  '1_monat':           'activation.duration.1month',
  '3_monate':          'activation.duration.3months',
  '1_jahr':            'activation.duration.1year',
  'benutzerdefiniert': 'activation.custom',
};

function CodeCountdown({ seconds }: { seconds: number }) {
  const { t } = useTranslation();
  const [remaining, setRemaining] = useState(seconds);

  useEffect(() => {
    setRemaining(seconds);
    if (seconds <= 0) return;
    const id = setInterval(() => setRemaining(s => Math.max(0, s - 1)), 1000);
    return () => clearInterval(id);
  }, [seconds]);

  if (remaining <= 0) {
    return <span style={{ color: 'var(--danger)' }}>{t('activation.expired')}</span>;
  }
  const mins = Math.floor(remaining / 60);
  const secs = remaining % 60;
  const color = remaining < 30 ? 'var(--danger)' : remaining < 60 ? 'var(--warning)' : 'var(--success)';

  return (
    <span className="font-mono font-bold tabular-nums" style={{ color }}>
      {String(mins).padStart(2, '0')}:{String(secs).padStart(2, '0')}
    </span>
  );
}

const ActivationPage: React.FC = () => {
  const { t } = useTranslation();
  const {
    profile, refreshSubscription, subscriptionExpiresAt,
    isSubscriptionActive, effectiveSubscriptionStatus,
  } = useAuth();
  const navigate = useNavigate();

  const [code, setCode] = useState('');
  const [submitState, setSubmitState] = useState<SubmitState>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const [newExpiry, setNewExpiry] = useState<string | null>(null);
  const [attempts, setAttempts] = useState(0);
  const [preview, setPreview] = useState<CodePreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const isBlocked = attempts >= 5;

  const fetchPreview = useCallback(async (inputCode: string) => {
    setPreviewLoading(true);
    try {
      const { data } = await supabase.rpc('preview_activation_code', { input_code: inputCode });
      const result = data as { success: boolean; status?: string; expires_at?: string; duration_type?: string; seconds_remaining?: number; error?: string } | null;
      if (result?.success && result.status === 'active' && (result.seconds_remaining ?? 0) > 0) {
        setPreview({
          status:            result.status!,
          expires_at:        result.expires_at!,
          duration_type:     result.duration_type!,
          seconds_remaining: result.seconds_remaining!,
        });
      } else {
        setPreview(null);
      }
    } catch {
      setPreview(null);
    } finally {
      setPreviewLoading(false);
    }
  }, []);

  const handleCodeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value.replace(/[^\d]/g, '').slice(0, 6);
    setCode(v);
    if (submitState === 'error') { setSubmitState('idle'); setErrorMsg(''); }
    if (v.length === 6) {
      fetchPreview(v);
    } else {
      setPreview(null);
    }
  };

  // Redirect to billing after successful activation
  useEffect(() => {
    if (submitState === 'success') {
      const timer = setTimeout(() => navigate('/billing', { replace: true }), 2200);
      return () => clearTimeout(timer);
    }
  }, [submitState, navigate]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const clean = code.replace(/\s/g, '');
    if (clean.length !== 6 || !/^\d{6}$/.test(clean)) {
      setErrorMsg(t('activation.sixDigits'));
      setSubmitState('error');
      return;
    }
    setSubmitState('loading');
    setErrorMsg('');
    try {
      const { data, error } = await supabase.rpc('redeem_activation_code', { input_code: clean });
      if (error) throw new Error(error.message);
      const result = data as { success: boolean; error?: string; subscription_expires_at?: string };
      if (!result.success) {
        setAttempts(a => a + 1);
        setErrorMsg(result.error ?? t('activation.invalid'));
        setSubmitState('error');
        return;
      }
      setNewExpiry(result.subscription_expires_at ?? null);
      await refreshSubscription();
      setSubmitState('success');
    } catch (err: any) {
      setAttempts(a => a + 1);
      setErrorMsg(err.message || t('activation.genericError'));
      setSubmitState('error');
    }
  };

  const expiryDisplay = newExpiry ?? subscriptionExpiresAt;
  const displayName = profile?.email || profile?.full_name;
  const subInactive = !isSubscriptionActive;
  const subStatusLabel = isSubscriptionActive ? 'Aktiv' : (effectiveSubscriptionStatus === 'expired' ? t('activation.expiredShort') : 'Inaktiv');

  // ── Success view ────────────────────────────────────────────────────────────
  if (submitState === 'success') {
    return (
      <div className="max-w-lg mx-auto py-6">
        <div className="rounded-2xl p-8 text-center space-y-5" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}>
          <div className="w-16 h-16 rounded-full flex items-center justify-center mx-auto"
            style={{ background: 'rgba(34,197,94,0.12)', border: '1px solid rgba(34,197,94,0.25)' }}>
            <CheckCircle2 size={30} style={{ color: 'var(--success)' }} />
          </div>
          <div>
            <h2 className="text-xl font-bold mb-2" style={{ color: 'var(--text-primary)' }}>
              Abo erfolgreich aktiviert
            </h2>
            {expiryDisplay && (
              <div className="flex items-center justify-center gap-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
                <CalendarCheck size={14} style={{ color: 'var(--success)' }} />
                <span>{t('activation.aboActiveUntil')}</span>
                <span className="font-semibold" style={{ color: 'var(--success)' }}>
                  {format(new Date(expiryDisplay), 'dd.MM.yyyy', { locale: de })}
                </span>
              </div>
            )}
          </div>
          <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>
            Sie werden in Kürze weitergeleitet…
          </p>
        </div>
      </div>
    );
  }

  // ── Main form view ──────────────────────────────────────────────────────────
  return (
    <div className="max-w-lg mx-auto py-4 space-y-5">

      {/* Back button */}
      <button
        onClick={() => navigate('/billing')}
        className="flex items-center gap-1.5 text-sm font-medium transition-colors"
        style={{ color: 'var(--text-tertiary)' }}
        onMouseEnter={e => (e.currentTarget.style.color = 'var(--text-primary)')}
        onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-tertiary)')}
      >
        <ArrowLeft size={15} />
        Zurück zu Abonnement
      </button>

      {/* Page title */}
      <div>
        <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>{t('activation.activateAbo')}</h1>
        <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>
          Geben Sie Ihren Aktivierungscode ein, um Ihr Abonnement freizuschalten.
        </p>
      </div>

      {/* Subscription status card */}
      <div className="rounded-xl p-4" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}>
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0"
              style={{ background: subInactive ? 'var(--danger-subtle)' : 'rgba(34,197,94,0.10)' }}>
              <ShieldCheck size={16} style={{ color: subInactive ? 'var(--danger)' : 'var(--success)' }} />
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>
                Abo-Status
              </p>
              <p className="text-sm font-semibold mt-0.5" style={{ color: subInactive ? 'var(--danger)' : 'var(--success)' }}>
                {subStatusLabel}
              </p>
            </div>
          </div>
          {displayName && (
            <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
              Angemeldet als {displayName}
            </p>
          )}
        </div>
        <p className="text-xs mt-3" style={{ color: 'var(--text-tertiary)' }}>
          Der Aktivierungscode ist nach Erstellung 2 Minuten gültig. Geben Sie ihn direkt nach Erhalt ein.
        </p>
      </div>

      {/* Code form */}
      <div className="rounded-xl p-6 space-y-5" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)' }}>
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
            style={{ background: 'var(--accent-subtle)' }}>
            <KeyRound size={18} style={{ color: 'var(--accent)' }} />
          </div>
          <div>
            <h2 className="font-semibold" style={{ color: 'var(--text-primary)' }}>{t('activation.enterCode')}</h2>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-secondary)' }}>
              Den Code erhalten Sie von Ihrem Administrator
            </p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {submitState === 'error' && errorMsg && (
            <div className="p-3.5 rounded-xl flex items-start gap-2.5"
              style={{ background: 'var(--danger-subtle)', border: '1px solid rgba(239,68,68,0.2)' }}>
              <AlertCircle size={15} style={{ color: 'var(--danger)', flexShrink: 0, marginTop: 1 }} />
              <span className="text-sm" style={{ color: 'var(--danger)' }}>{errorMsg}</span>
            </div>
          )}

          {isBlocked && (
            <div className="p-3.5 rounded-xl flex items-start gap-2.5"
              style={{ background: 'var(--warning-subtle)', border: '1px solid rgba(245,158,11,0.2)' }}>
              <AlertCircle size={15} style={{ color: 'var(--warning)', flexShrink: 0, marginTop: 1 }} />
              <span className="text-sm" style={{ color: 'var(--warning)' }}>
                Zu viele Versuche. Bitte wenden Sie sich an den Support.
              </span>
            </div>
          )}

          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider mb-2"
              style={{ color: 'var(--text-tertiary)' }}>
              Aktivierungscode
            </label>
            <input
              type="text"
              inputMode="numeric"
              pattern="\d{6}"
              maxLength={6}
              value={code}
              onChange={handleCodeChange}
              disabled={submitState === 'loading' || isBlocked}
              placeholder={t('activation.codePlaceholder')}
              autoFocus
              className="w-full px-4 py-4 rounded-xl focus:outline-none focus:ring-2 transition-all text-2xl font-mono tracking-[0.5em] text-center disabled:opacity-40"
              style={{
                background: 'var(--bg-subtle)',
                border: '1px solid var(--border)',
                color: 'var(--text-primary)',
              }}
              onFocus={e => (e.currentTarget.style.borderColor = 'var(--accent)')}
              onBlur={e => (e.currentTarget.style.borderColor = 'var(--border)')}
            />
          </div>

          {/* Preview countdown — shown when 6 digits are typed */}
          {code.length === 6 && (
            <div className="flex items-center justify-center gap-2 py-2.5 rounded-lg"
              style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)' }}>
              {previewLoading ? (
                <><RefreshCw size={13} className="animate-spin" style={{ color: 'var(--text-tertiary)' }} />
                <span className="text-sm" style={{ color: 'var(--text-tertiary)' }}>{t('activation.checking')}</span></>
              ) : preview ? (
                <>
                  <Clock size={13} style={{ color: 'var(--text-tertiary)' }} />
                  <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>{t('activation.validFor')}</span>
                  <CodeCountdown seconds={preview.seconds_remaining} />
                  <span className="text-xs px-1.5 py-0.5 rounded-md font-medium"
                    style={{ background: 'var(--accent-subtle)', color: 'var(--accent)' }}>
                    {DURATION_LABELS[preview.duration_type] ? t(DURATION_LABELS[preview.duration_type]) : preview.duration_type}
                  </span>
                </>
              ) : (
                <span className="text-sm" style={{ color: 'var(--text-tertiary)' }}>
                  Code nicht gefunden oder abgelaufen
                </span>
              )}
            </div>
          )}

          <button
            type="submit"
            disabled={code.length !== 6 || submitState === 'loading' || isBlocked}
            className="w-full py-3.5 px-4 rounded-xl font-semibold text-sm transition-all duration-200 disabled:opacity-40 disabled:cursor-not-allowed hover:-translate-y-0.5 flex items-center justify-center gap-2"
            style={{
              background: 'linear-gradient(135deg, #06b6d4, #3b82f6)',
              color: '#fff',
              boxShadow: code.length === 6 && !isBlocked ? '0 4px 16px rgba(6,182,212,0.3)' : 'none',
            }}
          >
            {submitState === 'loading' ? (
              <><RefreshCw size={15} className="animate-spin" />{t('activation.beingChecked')}</>
            ) : (
              <><KeyRound size={15} />{t('activation.redeem')}</>
            )}
          </button>
        </form>
      </div>
    </div>
  );
};

export default ActivationPage;
