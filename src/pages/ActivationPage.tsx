import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  KeyRound, CheckCircle2, RefreshCw,
  CalendarCheck, ArrowLeft, Clock, ShieldCheck,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { usePlan } from '../contexts/PlanContext';
import { supabase } from '../lib/supabase';
import { format, differenceInDays } from 'date-fns';
import { de } from 'date-fns/locale';
import { useTranslation } from '../contexts/LanguageContext';
import type { TranslationKey } from '../i18n';
import { Alert, Badge, Button, Card, Field, Input, cn } from '../components/ui';

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

  // ── Presentation (phase 5) ──
  // The countdown above is unchanged; the colour it ends in moved to a token.
  if (remaining <= 0) {
    return <span className="font-semibold text-critical">{t('activation.expired')}</span>;
  }
  const mins = Math.floor(remaining / 60);
  const secs = remaining % 60;
  // The same three thresholds as before: under half a minute, under a minute, more.
  const tone = remaining < 30 ? 'text-critical' : remaining < 60 ? 'text-caution' : 'text-positive';

  return (
    <span className={cn('font-mono font-bold tabular-nums', tone)}>
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
  // `redeem_activation_code` writes the subscription this page's own plan state
  // was built from, so the plan is re-read as well. Without it the customer
  // lands on /billing with the row from before the code — subscription
  // inactive — and every gated screen stays locked until the tab is reloaded.
  const { refresh: refreshPlan } = usePlan();
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
      await Promise.all([refreshSubscription(), refreshPlan()]);
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

  // ── Presentation (phase 5) ────────────────────────────────────────────────
  // Everything above is unchanged — the preview, the five-attempt block, the
  // redeem_activation_code call, the refresh of the subscription and the plan,
  // the redirect to /billing — except the status word's last line: the same
  // three answers, now in the UI language where they were German literals.
  const subStatusLabel = isSubscriptionActive ? t('sa.status.active') : (effectiveSubscriptionStatus === 'expired' ? t('activation.expiredShort') : t('sa.status.inactive'));

  // ── Success view ────────────────────────────────────────────────────────────
  if (submitState === 'success') {
    return (
      <div className="mx-auto max-w-lg py-6 font-ui">
        <Card role="status" className="grid gap-5 p-8 text-center">
          <span aria-hidden className="mx-auto flex size-16 items-center justify-center rounded-full bg-positive-soft text-positive">
            <CheckCircle2 className="size-8" />
          </span>
          <div>
            <h1 className="mb-2 text-xl font-semibold text-fg">{t('activation.successTitle')}</h1>
            {expiryDisplay && (
              <div className="flex flex-wrap items-center justify-center gap-2 text-sm text-fg-muted">
                <CalendarCheck aria-hidden className="size-3.5 text-positive" />
                <span>{t('activation.aboActiveUntil')}</span>
                <span className="font-semibold tabular-nums text-positive">
                  {format(new Date(expiryDisplay), 'dd.MM.yyyy', { locale: de })}
                </span>
              </div>
            )}
          </div>
          <p className="text-sm text-fg-subtle">{t('activation.redirecting')}</p>
        </Card>
      </div>
    );
  }

  // ── Main form view ──────────────────────────────────────────────────────────
  return (
    <div className="mx-auto grid max-w-lg grid-cols-1 gap-5 py-4 font-ui">

      {/* Back button */}
      <Button variant="ghost" size="sm" onClick={() => navigate('/billing')} className="-ml-2 justify-self-start">
        <ArrowLeft aria-hidden />
        {t('activation.backToBilling')}
      </Button>

      {/* Page title */}
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-fg">{t('activation.activateAbo')}</h1>
        <p className="mt-1 text-sm text-fg-muted">{t('activation.subtitle')}</p>
      </div>

      {/* Subscription status card */}
      <Card className="p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span
              aria-hidden
              className={cn(
                'flex size-9 shrink-0 items-center justify-center rounded-control',
                subInactive ? 'bg-critical-soft text-critical' : 'bg-positive-soft text-positive',
              )}
            >
              <ShieldCheck className="size-4" />
            </span>
            <div>
              <p className="text-xs font-medium text-fg-muted">{t('activation.statusLabel')}</p>
              <p className={cn('mt-0.5 text-sm font-semibold', subInactive ? 'text-critical' : 'text-positive')}>
                {subStatusLabel}
              </p>
            </div>
          </div>
          {displayName && (
            <p className="min-w-0 break-all text-xs text-fg-subtle">
              {t('activation.signedInAs', { name: displayName })}
            </p>
          )}
        </div>
        <p className="mt-3 text-xs text-fg-subtle">{t('activation.validityNote')}</p>
      </Card>

      {/* Code form */}
      <Card className="grid gap-5 p-5 sm:p-6">
        <div className="flex items-center gap-3">
          <span aria-hidden className="flex size-10 shrink-0 items-center justify-center rounded-surface bg-brand-soft text-brand-text">
            <KeyRound className="size-[18px]" />
          </span>
          <div>
            <h2 className="font-semibold text-fg">{t('activation.enterCode')}</h2>
            <p className="mt-0.5 text-xs text-fg-muted">{t('activation.codeFromAdmin')}</p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="grid gap-4">
          {submitState === 'error' && errorMsg && (
            <Alert tone="critical" title={errorMsg} />
          )}

          {isBlocked && (
            <Alert tone="caution" title={t('activation.tooManyAttempts')} />
          )}

          <Field label={t('activation.codeLabel')}>
            <Input
              type="text"
              inputMode="numeric"
              pattern="\d{6}"
              maxLength={6}
              value={code}
              onChange={handleCodeChange}
              disabled={submitState === 'loading' || isBlocked}
              placeholder={t('activation.codePlaceholder')}
              autoFocus
              // The digits are spaced out; the placeholder is a phrase and is not,
              // or "6-stelliger Code" runs off a phone's width.
              className="h-16 text-center font-mono text-2xl tracking-[0.5em] placeholder:font-ui placeholder:text-base placeholder:tracking-normal [@media(pointer:coarse)]:h-16 [@media(pointer:coarse)]:text-2xl"
            />
          </Field>

          {/* Preview countdown — shown when 6 digits are typed */}
          {code.length === 6 && (
            <div role="status" className="flex flex-wrap items-center justify-center gap-2 rounded-control border border-line bg-sunken py-2.5 text-sm">
              {previewLoading ? (
                <><RefreshCw aria-hidden className="size-3.5 text-fg-subtle motion-safe:animate-spin" />
                <span className="text-fg-muted">{t('activation.checking')}</span></>
              ) : preview ? (
                <>
                  <Clock aria-hidden className="size-3.5 text-fg-subtle" />
                  <span className="text-fg-muted">{t('activation.validFor')}</span>
                  <CodeCountdown seconds={preview.seconds_remaining} />
                  <Badge tone="brand">
                    {DURATION_LABELS[preview.duration_type] ? t(DURATION_LABELS[preview.duration_type]) : preview.duration_type}
                  </Badge>
                </>
              ) : (
                <span className="text-fg-muted">{t('activation.codeNotFound')}</span>
              )}
            </div>
          )}

          <Button
            type="submit"
            size="lg"
            disabled={code.length !== 6 || submitState === 'loading' || isBlocked}
            className="w-full"
          >
            {submitState === 'loading' ? (
              <><RefreshCw aria-hidden className="motion-safe:animate-spin" />{t('activation.beingChecked')}</>
            ) : (
              <><KeyRound aria-hidden />{t('activation.redeem')}</>
            )}
          </Button>
        </form>
      </Card>
    </div>
  );
};

export default ActivationPage;
