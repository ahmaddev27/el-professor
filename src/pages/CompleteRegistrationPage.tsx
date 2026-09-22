import React, { useState } from 'react';
import { ArrowRight, Building2, LogOut, Trash2, User } from 'lucide-react';
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
import { SIGN_IN_PATH } from '../lib/adminGate';
import PlanSelection from '../components/signup/PlanSelection';
import NoticeBox from '../components/auth/NoticeBox';
import AuthShell from '../components/auth/AuthShell';
import { authFieldIconClass, authFieldWithIconClass } from '../components/auth/authStyles';
import { Button, Field, Input } from '../components/ui';
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
    window.history.replaceState(window.history.state, '', SIGN_IN_PATH);
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
        {/* Its sign-out goes through leaveToLogin: this page is rendered inside
            the registration screen, and the address may still be
            /auth/callback. */}
        <PendingApprovalPage onSignOut={leaveToLogin} />
      </>
    );
  }

  // ── Presentation (phase 5) ────────────────────────────────────────────────
  // Everything above is unchanged: the registration, the discard, the
  // sign-out that rewrites the address first, and the waiting page once the
  // company exists. Below, the form and the two ways out are drawn with the
  // design system; which of them shows (`dead`, `confirmDiscard`) is decided
  // exactly as before.

  return (
    <AuthShell
      width="wide"
      title={t('gsignup.title')}
      subtitle={t('gsignup.subtitle', { email: user?.email ?? '' })}
      footer={
        <>
          {!dead && (
            confirmDiscard ? (
              <div className="grid w-full gap-3 rounded-surface border border-line bg-raised p-4 text-left">
                <p className="text-sm leading-relaxed text-fg-muted">{t('gsignup.discardConfirm')}</p>
                <div className="grid grid-cols-2 gap-2">
                  <Button
                    type="button"
                    variant="danger"
                    onClick={() => { void discard(); }}
                    disabled={discarding}
                    loading={discarding}
                  >
                    {!discarding && <Trash2 aria-hidden />}
                    {t('common.yes')}
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => setConfirmDiscard(false)}
                  >
                    {t('common.no')}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="grid justify-items-center gap-1">
                <Button
                  type="button"
                  variant="link"
                  onClick={() => setConfirmDiscard(true)}
                  className="text-xs font-medium text-fg-muted hover:text-critical"
                >
                  {t('gsignup.discard')}
                </Button>
                <p className="text-xs text-fg-subtle">{t('gsignup.discardHint')}</p>
              </div>
            )
          )}

          {!dead && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => { void leaveToLogin(); }}
            >
              <LogOut aria-hidden />
              {t('common.logout')}
            </Button>
          )}
        </>
      }
    >
      <div className="grid gap-5">
        {googleSignInIntent?.from === 'invite' && (
          <NoticeBox tone="error" announce>{t('gsignup.inviteMismatch')}</NoticeBox>
        )}

        {error && <NoticeBox tone="error" announce>{error}</NoticeBox>}

        {dead ? (
          <Button type="button" variant="secondary" className="w-full" onClick={() => { void leaveToLogin(); }}>
            <LogOut aria-hidden />
            {t('common.logout')}
          </Button>
        ) : (
          <form onSubmit={submit} className="grid gap-5">
            <div>
              <h2 className="mb-1 text-base font-semibold text-fg">{t('gsignup.heading')}</h2>
              <p className="text-[13px] text-fg-muted">{t('gsignup.intro')}</p>
            </div>

            <Field label={t('signup.account.fullName')} id="gsignup-name">
              <div className="relative">
                <User aria-hidden className={authFieldIconClass} />
                <Input
                  id="gsignup-name"
                  type="text"
                  value={fullName}
                  onChange={event => setFullName(event.target.value)}
                  className={authFieldWithIconClass}
                  placeholder={t('signup.account.fullNamePlaceholder')}
                  required
                />
              </div>
            </Field>

            <Field label={t('signup.company.nameLabel')} id="gsignup-company">
              <div className="relative">
                <Building2 aria-hidden className={authFieldIconClass} />
                <Input
                  id="gsignup-company"
                  type="text"
                  value={companyName}
                  onChange={event => setCompanyName(event.target.value)}
                  className={authFieldWithIconClass}
                  placeholder={t('signup.company.namePlaceholder')}
                  required
                  autoFocus
                />
              </div>
            </Field>

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

            <Field
              label={<>{t('signup.account.referralCode')} <span className="font-normal text-fg-subtle">{t('signup.optional')}</span></>}
              id="gsignup-referral"
              error={referralError || undefined}
            >
              <Input
                id="gsignup-referral"
                type="text"
                value={referralCode}
                onChange={event => { setReferralCode(event.target.value.toUpperCase()); setReferralError(null); }}
                className="font-mono"
                placeholder={t('signup.account.referralPlaceholder')}
              />
            </Field>

            <Button
              type="submit"
              size="lg"
              disabled={submitting || !fullName.trim() || !companyName.trim()}
              loading={submitting}
              className="w-full"
            >
              {!submitting && <>{t('gsignup.submit')}<ArrowRight aria-hidden /></>}
            </Button>
          </form>
        )}
      </div>
    </AuthShell>
  );
};

export default CompleteRegistrationPage;
