import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Building2, User, Mail, Lock, Eye, EyeOff,
  CheckCircle2, ArrowLeft, ArrowRight, Check, LogIn,
} from 'lucide-react';
import { Plan } from '../contexts/PlanContext';
import type { BillingCycle, DiscountResult } from '../utils/pricing';
import { useAppConfig } from '../contexts/AppConfigContext';
import { useTranslation } from '../contexts/LanguageContext';
import type { TranslationKey } from '../i18n';
import { useOtpSessionHandoff } from '../hooks/useOtpSessionHandoff';
import { formatOtpMessage, normalizeEmail, type OtpVerifyFailure, type OtpVerifySuccess } from '../lib/otpClient';
import { signupFailure, signupVerificationStart, type VerificationStart } from '../lib/accountFunctionResponses';
import EmphasizedText from '../components/auth/EmphasizedText';
import GoogleButton from '../components/auth/GoogleButton';
import { LegalLinks } from '../components/legal/LegalLinks';
import NoticeBox from '../components/auth/NoticeBox';
import OtpChallenge from '../components/auth/OtpChallenge';
import AuthShell from '../components/auth/AuthShell';
import { authFieldIconClass, authFieldWithIconClass, authLinkClass } from '../components/auth/authStyles';
import { Alert, Button, Field, Input, cn } from '../components/ui';
import PlanSelection from '../components/signup/PlanSelection';
import { planDef } from '../components/signup/plans';

// 'verify' follows a successful company-signup: the account exists and waits
// for the code, so there is no way back to the earlier steps from there.
type Step = 'plan' | 'company' | 'account' | 'verify';

const STEPS: Step[] = ['plan', 'company', 'account', 'verify'];

const STEP_LABEL_KEYS: Record<Step, TranslationKey> = {
  plan:    'signup.step.plan',
  company: 'signup.step.company',
  account: 'signup.step.account',
  verify:  'signup.step.verify',
};

// ─── Component ────────────────────────────────────────────────────────────────

const SignupPage: React.FC = () => {
  // The trial length comes from the database (plan 3.9), like the prices the
  // plan block quotes.
  const { trialDays } = useAppConfig();
  const { t, tPlural } = useTranslation();
  const completeSignIn = useOtpSessionHandoff();
  const [step, setStep] = useState<Step>('plan');
  const [selectedPlan, setSelectedPlan] = useState<Plan>('advanced');
  const [billingCycle, setBillingCycle] = useState<BillingCycle>('monthly');
  const [carLimit, setCarLimit] = useState(3);
  const [companyName, setCompanyName] = useState('');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [appliedDiscount, setAppliedDiscount] = useState<DiscountResult | null>(null);
  const [referralCode, setReferralCode] = useState('');
  const [referralError, setReferralError] = useState('');
  const [verification, setVerification] = useState<VerificationStart | null>(null);
  const [verifiedWithoutSession, setVerifiedWithoutSession] = useState(false);

  const stepIndex = STEPS.indexOf(step);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setReferralError('');
    if (password.length < 8) {
      setError(t('account.error.pwShort', { n: 8 }));
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/company-signup`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            // Nobody has a session yet — this call creates the first one. The
            // publishable key is what the edge router checks for the public
            // signup path; without it the request is refused before reaching
            // the function.
            'Apikey': import.meta.env.VITE_SUPABASE_ANON_KEY,
          },
          body: JSON.stringify({
            company_name: companyName.trim(),
            full_name: fullName.trim(),
            email: email.trim(),
            password,
            plan: selectedPlan,
            billing_cycle: billingCycle,
            subscription_car_limit: carLimit,
            // The code the user typed, not the id the validation returned.
            // The server keeps it with the pending signup and redeems it only
            // once the address is confirmed, so an unverified signup cannot
            // use up a limited code. It computes the price itself.
            discount_code: appliedDiscount?.code ?? null,
            referral_code: referralCode.trim() || null,
          }),
        }
      );
      const data: unknown = await res.json().catch(() => null);
      const succeeded = res.ok && typeof data === 'object' && data !== null
        && (data as { success?: unknown }).success === true;
      if (!succeeded) {
        // Branch on the reason company-signup reports, never on its German text.
        const failure = signupFailure(data, referralCode);
        const text = formatOtpMessage(failure.message, t, tPlural);
        if (failure.field === 'referral') setReferralError(text);
        else setError(text);
        return;
      }
      // The account exists but cannot sign in until its address is confirmed.
      // company-signup has already sent the code, or reports why it could not.
      setVerification(signupVerificationStart(data));
      setPassword('');
      setStep('verify');
    } catch {
      setError(t('forgot.unexpected'));
    } finally {
      setLoading(false);
    }
  };

  const handleVerified = async (result: OtpVerifySuccess): Promise<OtpVerifyFailure | void> => {
    if (!('session' in result)) return { ok: false, reason: 'internal' };
    // App shows PendingApprovalPage for the new company once the profile loads.
    const signedIn = await completeSignIn(result.session, '/');
    if (!signedIn) return { ok: false, reason: 'session_failed' };
  };

  // After session_failed the address is already confirmed, so a new code would
  // be refused; the password chosen a moment ago signs in instead.
  const handleVerifyFailure = (result: OtpVerifyFailure): boolean => {
    if (result.reason !== 'session_failed') return false;
    setVerifiedWithoutSession(true);
    return true;
  };

  const selectedPlanDef = planDef(selectedPlan);

  // ── Presentation (phase 5) ────────────────────────────────────────────────
  // Everything above is unchanged: the steps, company-signup and its body,
  // the hand-off after the code, and the confirmed-but-not-signed-in path. What
  // lived in the markup is kept as it was — the company step's submit (no empty
  // name), the two back buttons, "continue with", the submit button's rule.

  const stepIndicator = (
    <ol className="mb-6 flex items-center justify-center gap-2 font-ui">
      {STEPS.map((s, i) => (
        <React.Fragment key={s}>
          <li className="flex items-center gap-1.5" aria-current={step === s ? 'step' : undefined}>
            <span className={cn(
              'flex size-6 items-center justify-center rounded-full text-xs font-semibold tabular-nums',
              step === s
                ? 'bg-brand text-brand-fg'
                : i < stepIndex
                  ? 'bg-positive-soft text-positive'
                  : 'bg-sunken text-fg-subtle',
            )}>
              {i < stepIndex ? <Check size={12} aria-hidden="true" /> : i + 1}
            </span>
            <span className={cn('hidden text-xs font-medium sm:inline', step === s ? 'text-fg' : 'text-fg-subtle')}>
              {t(STEP_LABEL_KEYS[s])}
            </span>
          </li>
          {i < STEPS.length - 1 && <li aria-hidden className={cn('h-px w-6', i < stepIndex ? 'bg-positive' : 'bg-line')} />}
        </React.Fragment>
      ))}
    </ol>
  );

  const heading = (title: string, sub: React.ReactNode) => (
    <div>
      <h2 className="mb-1 text-base font-semibold text-fg">{title}</h2>
      <p className="text-[13px] text-fg-muted">{sub}</p>
    </div>
  );

  return (
    <AuthShell
      width="wide"
      title={t('signup.cta')}
      subtitle={t('signup.subtitle', { days: trialDays })}
      above={stepIndicator}
      footer={
        <>
          <p className="text-sm text-fg-muted">
            {t('signup.alreadyRegistered')}{' '}
            <Link to="/login" className={authLinkClass}>{t('auth.signIn')}</Link>
          </p>
          {/* #97's Impressum and Datenschutz links. The page follows the theme
              now, so they take the theme's tone rather than `onDark`. */}
          <LegalLinks className="justify-center" />
        </>
      }
    >

          {/* ── Step 4: Confirm the email address ── */}
          {step === 'verify' && (
            <div className="grid gap-5">
              {heading(
                t('signup.verify.heading'),
                <span className="break-words">
                  <EmphasizedText
                    template={t('signup.verify.subheading')}
                    placeholder="email"
                    value={normalizeEmail(email)}
                    className="font-medium text-fg"
                  />
                </span>,
              )}

              <div className="mx-auto w-full max-w-sm">
                {verifiedWithoutSession ? (
                  <div className="grid gap-4">
                    <NoticeBox tone="success" announce>{t('signup.verify.verifiedLogin')}</NoticeBox>
                    <Button asChild size="lg" className="w-full">
                      <Link to="/login" replace>
                        <LogIn size={15} aria-hidden="true" />
                        <span>{t('auth.signIn')}</span>
                      </Link>
                    </Button>
                  </div>
                ) : (
                  // No "code sent to" hint: when the send failed, that sentence
                  // would be false. The subheading and the first notice say
                  // what actually happened.
                  <OtpChallenge
                    purpose="signup_verify"
                    email={normalizeEmail(email)}
                    initialCooldownSeconds={verification?.cooldownSeconds ?? 0}
                    initialNotice={verification?.notice ?? null}
                    hint={null}
                    onVerified={handleVerified}
                    onFailure={handleVerifyFailure}
                  />
                )}
              </div>
            </div>
          )}

          {/* ── Step 1: Plan + Car Count + Billing Cycle ── */}
          {step === 'plan' && (
            <div className="grid gap-5">
              {heading(t('signup.plan.heading'), t('signup.plan.subheading', { days: trialDays }))}

              {/* The same block the Google registration screen shows, so both
                  paths sell the same tiers at the same prices. */}
              <PlanSelection
                plan={selectedPlan}
                carLimit={carLimit}
                billingCycle={billingCycle}
                discount={appliedDiscount}
                onPlanChange={setSelectedPlan}
                onCarLimitChange={setCarLimit}
                onBillingCycleChange={setBillingCycle}
                onDiscountChange={setAppliedDiscount}
              />

              <Button size="lg" className="w-full" onClick={() => setStep('company')}>
                {t('signup.continueWith', { plan: selectedPlanDef.name })}
                <ArrowRight aria-hidden />
              </Button>
            </div>
          )}

          {/* ── Step 2: Company ── */}
          {step === 'company' && (
            <form onSubmit={e => { e.preventDefault(); if (companyName.trim()) setStep('account'); }} className="grid gap-5">
              <div className="grid gap-4">
                <Button type="button" variant="ghost" size="sm" onClick={() => setStep('plan')} className="-ml-2 justify-self-start">
                  <ArrowLeft aria-hidden />
                  {selectedPlanDef.name} · {carLimit} {t('signup.vehiclesUnit')}
                </Button>
                {heading(t('signup.company.heading'), t('signup.company.subheading'))}
              </div>
              <Field label={t('signup.company.nameLabel')}>
                <div className="relative">
                  <Building2 aria-hidden className={authFieldIconClass} />
                  <Input
                    type="text"
                    value={companyName}
                    onChange={e => setCompanyName(e.target.value)}
                    className={authFieldWithIconClass}
                    placeholder={t('signup.company.namePlaceholder')}
                    required
                    autoFocus
                  />
                </div>
              </Field>
              <Button type="submit" size="lg" disabled={!companyName.trim()} className="w-full">
                {t('signup.next')}
                <ArrowRight aria-hidden />
              </Button>
            </form>
          )}

          {/* ── Step 3: Account ── */}
          {step === 'account' && (
            <>
              <form onSubmit={handleSubmit} className="grid gap-4">
                <div className="grid gap-4">
                  <Button type="button" variant="ghost" size="sm" onClick={() => { setStep('company'); setError(''); }} className="-ml-2 max-w-full justify-self-start">
                    <ArrowLeft aria-hidden />
                    <span className="truncate">{companyName}</span>
                  </Button>
                  {heading(t('signup.account.heading'), t('signup.account.subheading'))}
                </div>

                {error && <Alert tone="critical" title={error} />}

                <Field label={t('signup.account.fullName')}>
                  <div className="relative">
                    <User aria-hidden className={authFieldIconClass} />
                    <Input type="text" value={fullName} onChange={e => setFullName(e.target.value)} className={authFieldWithIconClass} placeholder={t('signup.account.fullNamePlaceholder')} required />
                  </div>
                </Field>

                <Field label={t('auth.email')}>
                  <div className="relative">
                    <Mail aria-hidden className={authFieldIconClass} />
                    <Input type="email" value={email} onChange={e => setEmail(e.target.value)} className={authFieldWithIconClass} placeholder={t('signup.account.emailPlaceholder')} required />
                  </div>
                </Field>

                <Field label={t('auth.password')}>
                  <div className="relative">
                    <Lock aria-hidden className={authFieldIconClass} />
                    <Input
                      type={showPassword ? 'text' : 'password'}
                      value={password}
                      onChange={e => setPassword(e.target.value)}
                      className={cn(authFieldWithIconClass, 'pr-11')}
                      placeholder={t('signup.account.passwordPlaceholder')}
                      required
                      minLength={8}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => setShowPassword(v => !v)}
                      aria-label={showPassword ? t('auth.hidePassword') : t('auth.showPassword')}
                      className="absolute right-0.5 top-1/2 -translate-y-1/2"
                    >
                      {showPassword ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
                    </Button>
                  </div>
                </Field>

                <Field
                  label={<>{t('signup.account.referralCode')} <span className="font-normal text-fg-subtle">{t('signup.optional')}</span></>}
                  error={referralError || undefined}
                >
                  <Input
                    type="text"
                    value={referralCode}
                    onChange={e => { setReferralCode(e.target.value.toUpperCase()); setReferralError(''); }}
                    className="font-mono"
                    placeholder={t('signup.account.referralPlaceholder')}
                  />
                </Field>

                <Button
                  type="submit"
                  size="lg"
                  disabled={loading || !fullName.trim() || !email.trim() || password.length < 8}
                  loading={loading}
                  className="mt-1 w-full"
                >
                  {!loading && <CheckCircle2 aria-hidden />}
                  {t('signup.cta')}
                </Button>

                <p className="pt-1 text-center text-xs text-fg-subtle">
                  {t('signup.summaryLead', { days: trialDays })}
                  <strong className="font-semibold text-fg-muted">{selectedPlanDef.name}</strong>
                  {t('signup.summaryTail', {
                    cars: carLimit,
                    cycle: billingCycle === 'yearly' ? t('signup.billing.yearlyAdj') : t('signup.billing.monthlyAdj'),
                  })}
                </p>
              </form>

              {/* The same registration without a password (plan 1.6): Google
                  confirms the address, and the company is registered on the
                  screen that follows. The tier chosen above travels with the
                  marker, so it is still selected there. Nothing renders while
                  the provider is off. */}
              <GoogleButton
                from="signup"
                labelKey="auth.google.signUp"
                hintKey="gsignup.signupHint"
                divider
                selection={{ plan: selectedPlan, carLimit, billingCycle }}
                onError={key => setError(t(key))}
              />
            </>
          )}
    </AuthShell>
  );
};

export default SignupPage;
