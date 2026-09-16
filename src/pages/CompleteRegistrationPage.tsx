import React, { useState } from 'react';
import { AlertCircle, ArrowRight, Building2, Gift, LogOut, Trash2, User } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useTranslation } from '../contexts/LanguageContext';
import { Plan } from '../contexts/PlanContext';
import type { BillingCycle, DiscountResult } from '../utils/pricing';
import type { TranslationKey } from '../i18n';
import {
  discardOauthAccount,
  registerFailure,
  registerOauthCompany,
} from '../lib/oauthAccountClient';
import PlanSelection from '../components/signup/PlanSelection';
import NoticeBox from '../components/auth/NoticeBox';
import { authInputClass, authLabelClass, authSpinnerClass } from '../components/auth/authStyles';
import PendingApprovalPage from './PendingApprovalPage';

/**
 * The screen a Google account without a company lands on (plan step 1.6).
 *
 * Google gives us a confirmed address and a name, and nothing else: the company
 * behind it is still unknown. This screen asks for exactly what the password
 * signup asks for — company name, owner name, tier, fleet size, billing cycle,
 * a referral code and a discount code — and hands it to `oauth-account`'s
 * `register`, which is one transaction in the database: the company waiting for
 * approval, the owner active, the settings, and the discount redeemed.
 *
 * Afterwards the company waits for the owner's approval exactly as a password
 * signup does, so the screen shows the very same PendingApprovalPage rather
 * than a second one that would have to be kept in step with it.
 *
 * Two ways to leave without a company: sign out (the account stays, and the
 * daily purge removes it if it is never used) or delete the account outright.
 * The second is what an employee needs who opened their invitation with the
 * wrong Google account — the invited address is a different account, and this
 * one should not linger.
 *
 * App decides who sees this screen (`needsCompanyRegistration`), before every
 * company gate: an account with no company cannot be answered by any of them.
 */
const CompleteRegistrationPage: React.FC = () => {
  const { user, session, profile, signOut, refreshProfile, googleSignInIntent } = useAuth();
  const { t } = useTranslation();

  const selection = googleSignInIntent?.selection ?? null;
  const [plan, setPlan] = useState<Plan>(selection?.plan ?? 'advanced');
  const [carLimit, setCarLimit] = useState(selection?.carLimit ?? 3);
  const [billingCycle, setBillingCycle] = useState<BillingCycle>(selection?.billingCycle ?? 'monthly');
  const [discount, setDiscount] = useState<DiscountResult | null>(null);

  const [fullName, setFullName] = useState(() => {
    const metadata = (user?.user_metadata ?? {}) as Record<string, unknown>;
    const candidate = metadata.full_name ?? metadata.name;
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
    return profile?.full_name ?? '';
  });
  const [companyName, setCompanyName] = useState('');
  const [referralCode, setReferralCode] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [referralError, setReferralError] = useState<string | null>(null);
  /** The session cannot be used for this any more; only signing out is left. */
  const [dead, setDead] = useState(false);
  const [registered, setRegistered] = useState(false);
  const [discountFailed, setDiscountFailed] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [discarding, setDiscarding] = useState(false);

  const say = (key: TranslationKey) => setError(t(key));

  /**
   * Signing out swaps App's router; the public one starts wherever the address
   * points, so it is rewritten first — the same reason useOtpSessionHandoff
   * rewrites it before installing a session.
   */
  const leaveToLogin = async () => {
    window.history.replaceState(window.history.state, '', '/login');
    await signOut();
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setReferralError(null);

    const accessToken = session?.access_token;
    if (!accessToken) {
      say('gsignup.error.sessionGone');
      setDead(true);
      return;
    }

    setSubmitting(true);
    const result = await registerOauthCompany(
      {
        fullName: fullName.trim(),
        companyName: companyName.trim(),
        plan,
        billingCycle,
        carLimit,
        referralCode: referralCode.trim() || null,
        // The code as typed, not the validation's answer: the database redeems
        // it inside the transaction that creates the company, and prices it
        // itself — the same contract the password signup has.
        discountCode: discount?.code ?? null,
      },
      accessToken,
    );
    setSubmitting(false);

    if (!result.ok) {
      const failure = registerFailure(result.reason);
      const text = t(failure.message, { code: referralCode.trim().toUpperCase() });
      if (failure.field === 'referral') setReferralError(text);
      else setError(text);
      if (failure.fatal) setDead(true);
      return;
    }

    // The code was refused, the company stands: say so, and carry on.
    setDiscountFailed(result.discount !== null && !result.discount.success);
    setRegistered(true);
    // The gates read the profile; once it carries the new company, App shows
    // the waiting page itself.
    void refreshProfile();
  };

  const discard = async () => {
    const accessToken = session?.access_token;
    if (!accessToken) {
      await leaveToLogin();
      return;
    }
    setDiscarding(true);
    const result = await discardOauthAccount(accessToken);
    setDiscarding(false);
    if (result.ok) {
      await leaveToLogin();
      return;
    }
    setConfirmDiscard(false);
    say('gsignup.discardFailed');
  };

  if (registered) {
    return (
      <>
        {discountFailed && (
          <div className="fixed inset-x-0 top-0 z-50 p-3">
            <div className="max-w-md mx-auto">
              <NoticeBox tone="error" announce>{t('gsignup.discountNotApplied')}</NoticeBox>
            </div>
          </div>
        )}
        <PendingApprovalPage />
      </>
    );
  }

  return (
    <div className="min-h-screen bg-[#060a0f] flex items-center justify-center p-4 relative overflow-hidden">
      <div className="absolute inset-0 bg-[linear-gradient(rgba(6,182,212,0.03)_1px,transparent_1px),linear-gradient(90deg,rgba(6,182,212,0.03)_1px,transparent_1px)] bg-[size:48px_48px]" />
      <div className="absolute top-1/4 left-1/2 -translate-x-1/2 w-[600px] h-[400px] bg-cyan-600/5 rounded-full blur-[120px] pointer-events-none" />

      <div className="relative w-full max-w-2xl py-8">
        <div className="text-center mb-6">
          <div className="w-14 h-14 mx-auto mb-3 flex items-center justify-center">
            <img src="/professor_logo_white.svg" alt="El-Professor" className="w-14 h-14 object-contain drop-shadow-[0_0_16px_rgba(6,182,212,0.5)]" />
          </div>
          <h1 className="text-2xl font-bold text-white mb-1">{t('gsignup.title')}</h1>
          <p className="text-white/40 text-sm break-words">
            {t('gsignup.subtitle', { email: user?.email ?? '' })}
          </p>
        </div>

        <div className="bg-white/4 backdrop-blur-xl border border-white/10 rounded-2xl p-6 shadow-[0_24px_64px_rgba(0,0,0,0.5)] space-y-5">
          {googleSignInIntent?.from === 'invite' && (
            <NoticeBox tone="error" announce>{t('gsignup.inviteMismatch')}</NoticeBox>
          )}

          {error && <NoticeBox tone="error" announce>{error}</NoticeBox>}

          {dead ? (
            <button type="button" onClick={() => { void leaveToLogin(); }} className="w-full flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl border border-white/10 text-white/60 hover:text-white hover:border-white/20 transition-all text-sm">
              <LogOut size={14} aria-hidden="true" />
              {t('common.logout')}
            </button>
          ) : (
            <form onSubmit={submit} className="space-y-5">
              <div>
                <h2 className="text-base font-semibold text-white mb-1">{t('gsignup.heading')}</h2>
                <p className="text-xs text-white/40">{t('gsignup.intro')}</p>
              </div>

              <div>
                <label htmlFor="gsignup-name" className={authLabelClass}>{t('signup.account.fullName')}</label>
                <div className="relative">
                  <User className="absolute left-3.5 top-1/2 -translate-y-1/2 text-white/25" size={16} aria-hidden="true" />
                  <input
                    id="gsignup-name"
                    type="text"
                    value={fullName}
                    onChange={event => setFullName(event.target.value)}
                    className={authInputClass}
                    placeholder={t('signup.account.fullNamePlaceholder')}
                    required
                  />
                </div>
              </div>

              <div>
                <label htmlFor="gsignup-company" className={authLabelClass}>{t('signup.company.nameLabel')}</label>
                <div className="relative">
                  <Building2 className="absolute left-3.5 top-1/2 -translate-y-1/2 text-white/25" size={16} aria-hidden="true" />
                  <input
                    id="gsignup-company"
                    type="text"
                    value={companyName}
                    onChange={event => setCompanyName(event.target.value)}
                    className={authInputClass}
                    placeholder={t('signup.company.namePlaceholder')}
                    required
                    autoFocus
                  />
                </div>
              </div>

              <PlanSelection
                plan={plan}
                carLimit={carLimit}
                billingCycle={billingCycle}
                discount={discount}
                onPlanChange={setPlan}
                onCarLimitChange={setCarLimit}
                onBillingCycleChange={setBillingCycle}
                onDiscountChange={setDiscount}
              />

              <div>
                <label htmlFor="gsignup-referral" className={authLabelClass}>
                  <Gift size={11} className="inline mr-1" aria-hidden="true" />
                  {t('signup.account.referralCode')}{' '}
                  <span className="text-white/20 normal-case tracking-normal font-normal">{t('signup.optional')}</span>
                </label>
                <div className="relative">
                  <Gift className="absolute left-3.5 top-1/2 -translate-y-1/2 text-white/25" size={16} aria-hidden="true" />
                  <input
                    id="gsignup-referral"
                    type="text"
                    value={referralCode}
                    onChange={event => { setReferralCode(event.target.value.toUpperCase()); setReferralError(null); }}
                    className={`${authInputClass} font-mono`}
                    placeholder={t('signup.account.referralPlaceholder')}
                  />
                </div>
                {referralError && (
                  <p className="mt-1.5 text-xs flex items-center gap-1.5 text-red-400">
                    <AlertCircle size={11} aria-hidden="true" />
                    {referralError}
                  </p>
                )}
              </div>

              <button
                type="submit"
                disabled={submitting || !fullName.trim() || !companyName.trim()}
                className="w-full bg-gradient-to-r from-cyan-500 to-blue-600 text-white py-3 px-4 rounded-xl font-semibold text-sm hover:shadow-[0_4px_24px_rgba(6,182,212,0.4)] hover:-translate-y-0.5 transition-all duration-200 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:translate-y-0 flex items-center justify-center gap-2"
              >
                {submitting
                  ? <span className={authSpinnerClass} aria-hidden="true" />
                  : <>{t('gsignup.submit')}<ArrowRight size={15} aria-hidden="true" /></>}
              </button>
            </form>
          )}
        </div>

        <div className="mt-5 space-y-3 text-center">
          {!dead && (
            confirmDiscard ? (
              <div className="bg-white/4 border border-white/10 rounded-2xl p-4 space-y-3 text-left">
                <p className="text-sm text-white/70 leading-relaxed">{t('gsignup.discardConfirm')}</p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => { void discard(); }}
                    disabled={discarding}
                    className="flex-1 flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl border border-red-500/30 bg-red-500/10 text-red-300 hover:bg-red-500/20 transition-colors text-sm font-semibold disabled:opacity-50"
                  >
                    {discarding ? <span className={authSpinnerClass} aria-hidden="true" /> : <Trash2 size={14} aria-hidden="true" />}
                    {t('common.yes')}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmDiscard(false)}
                    className="flex-1 py-2.5 px-4 rounded-xl border border-white/10 text-white/60 hover:text-white hover:border-white/20 transition-all text-sm"
                  >
                    {t('common.no')}
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-1">
                <button
                  type="button"
                  onClick={() => setConfirmDiscard(true)}
                  className="text-xs text-white/35 hover:text-red-300 transition-colors"
                >
                  {t('gsignup.discard')}
                </button>
                <p className="text-[11px] text-white/20">{t('gsignup.discardHint')}</p>
              </div>
            )
          )}

          {!dead && (
            <button
              type="button"
              onClick={() => { void leaveToLogin(); }}
              className="inline-flex items-center gap-1.5 text-white/40 hover:text-white/70 text-sm transition-colors"
            >
              <LogOut size={14} aria-hidden="true" />
              {t('common.logout')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default CompleteRegistrationPage;
