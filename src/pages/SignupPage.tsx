import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Building2, User, Mail, Lock, Eye, EyeOff,
  AlertCircle, CheckCircle2, ArrowLeft, ArrowRight, Zap, Check, Car, Tag, X, Gift, LogIn,
} from 'lucide-react';
import { supabase } from '../lib/supabase';
import { Plan } from '../contexts/PlanContext';
import { calcPricing, fleetDiscountPercent, fmtPricePerCar, fmt as fmtPrice } from '../utils/pricing';
import type { BillingCycle, DiscountResult } from '../utils/pricing';
import { useAppConfig } from '../contexts/AppConfigContext';
import { useTranslation } from '../contexts/LanguageContext';
import type { TranslationKey } from '../i18n';
import { useOtpSessionHandoff } from '../hooks/useOtpSessionHandoff';
import { formatOtpMessage, normalizeEmail, type OtpVerifyFailure, type OtpVerifySuccess } from '../lib/otpClient';
import { signupFailure, signupVerificationStart, type VerificationStart } from '../lib/accountFunctionResponses';
import EmphasizedText from '../components/auth/EmphasizedText';
import NoticeBox from '../components/auth/NoticeBox';
import OtpChallenge from '../components/auth/OtpChallenge';
import { authPrimaryButtonClass } from '../components/auth/authStyles';

// 'verify' follows a successful company-signup: the account exists and waits
// for the code, so there is no way back to the earlier steps from there.
type Step = 'plan' | 'company' | 'account' | 'verify';

const inputClass =
  'w-full px-4 py-3 bg-white/5 border border-white/10 text-white placeholder-white/20 rounded-xl focus:outline-none focus:ring-2 focus:ring-cyan-500/50 focus:border-cyan-500/40 transition-all text-sm';
const labelClass = 'block text-xs font-semibold text-white/40 uppercase tracking-wider mb-2';

// ─── Plan definitions ─────────────────────────────────────────────────────────

interface PlanDef {
  id: Plan;
  /** Product name — a tier is called Basic/Advanced/Premium in every language. */
  name: string;
  sub: TranslationKey;
  highlight: boolean;
  color: string;
  features: TranslationKey[];
}

// `sub` and `features` hold TranslationKeys: this list is module-level and t()
// is a hook value. Every consumer resolves it at the render site.
const PLANS: PlanDef[] = [
  {
    id: 'basic',
    name: 'Basic',
    sub: 'signup.plan.basicSub',
    highlight: false,
    color: '#06b6d4',
    features: ['nav.overview', 'nav.belege', 'nav.fahrer', 'nav.cars', 'nav.umsaetze', 'nav.fixkosten', 'nav.bargeldbestand'],
  },
  {
    id: 'advanced',
    name: 'Advanced',
    sub: 'landing.plan.advancedSub',
    highlight: true,
    color: '#f59e0b',
    features: ['signup.plan.everythingInBasic', 'nav.werkstatt', 'nav.abrechnung', 'nav.notes', 'locked.feature.rollenNutzer'],
  },
  {
    id: 'premium',
    name: 'Premium',
    sub: 'landing.plan.premiumSub',
    highlight: false,
    color: '#10b981',
    features: ['signup.plan.everythingInAdvanced', 'nav.salaries', 'nav.documents', 'locked.feature.stundennachweis'],
  },
];

const STEPS: Step[] = ['plan', 'company', 'account', 'verify'];

const STEP_LABEL_KEYS: Record<Step, TranslationKey> = {
  plan:    'signup.step.plan',
  company: 'signup.step.company',
  account: 'signup.step.account',
  verify:  'signup.step.verify',
};

// ─── PricePreview ─────────────────────────────────────────────────────────────

const PricePreview: React.FC<{
  plan: Plan;
  carLimit: number;
  billingCycle: BillingCycle;
  discount?: DiscountResult | null;
}> = ({ plan, carLimit, billingCycle, discount }) => {
  const { t } = useTranslation();
  // The same price book compute_plan_price charges from (plan 3.9).
  const { priceBook } = useAppConfig();
  const bp = calcPricing(priceBook, plan, carLimit, billingCycle);
  const fleetPct = fleetDiscountPercent(priceBook, carLimit);
  const planColor = PLANS.find(p => p.id === plan)?.color ?? '#06b6d4';

  // current_price that was passed to edge fn = bp.finalTotal
  const finalPrice = discount ? discount.final_price : bp.finalTotal;

  return (
    <div className="rounded-xl p-4 border" style={{
      background: `${planColor}0d`,
      borderColor: `${planColor}30`,
    }}>
      <p className="text-xs font-semibold uppercase tracking-wider mb-3" style={{ color: planColor }}>
        {t('signup.price.heading')}
      </p>
      <div className="space-y-1.5 text-xs">
        <div className="flex justify-between text-white/50">
          <span>{t('signup.price.base')} ({carLimit} × {fmtPricePerCar(priceBook.price_per_car_cents[plan])} €)</span>
          <span>{fmtPrice(bp.baseMonthly)} €</span>
        </div>
        {fleetPct > 0 && (
          <div className="flex justify-between" style={{ color: '#34d399' }}>
            <span>{t('landing.pricing.fleetDiscount')} -{fleetPct}%</span>
            <span>-{fmtPrice(bp.baseMonthly - bp.monthlyAfterFleet)} €</span>
          </div>
        )}
        {billingCycle === 'yearly' && (
          <div className="flex justify-between" style={{ color: '#fbbf24' }}>
            <span>{t('landing.pricing.yearlyDiscount')} -{priceBook.yearly_discount_percent}%</span>
            <span>
              -{fmtPrice(billingCycle === 'yearly' ? bp.monthlyAfterFleet * 12 - bp.yearlyTotal : 0)} €
            </span>
          </div>
        )}
        {discount && (
          <div className="flex justify-between" style={{ color: '#34d399' }}>
            <span>{t('signup.discount.label')} ({discount.code})</span>
            <span>-{fmtPrice(discount.discount_amount)} €</span>
          </div>
        )}
        <div className="pt-2 border-t border-white/10 flex justify-between font-bold" style={{ color: planColor }}>
          {billingCycle === 'yearly' ? (
            <>
              <span>{t('signup.price.finalYearly')}</span>
              <span>{fmtPrice(finalPrice)} €</span>
            </>
          ) : (
            <>
              <span>{t('signup.price.finalMonthly')}</span>
              <span>{fmtPrice(finalPrice)} €</span>
            </>
          )}
        </div>
        {billingCycle === 'yearly' && (
          <div className="flex justify-between text-white/35 text-[11px]">
            <span>{t('signup.price.monthlyEquivalent')}</span>
            <span>{fmtPrice(finalPrice / 12)} € {t('signup.price.perMonth')}</span>
          </div>
        )}
      </div>
      <p className="text-[10px] text-white/25 mt-3">
        {t('signup.price.driverLimitNote', { count: carLimit * 4 })}
      </p>
    </div>
  );
};

// ─── DiscountCodeInput ────────────────────────────────────────────────────────

const DiscountCodeInput: React.FC<{
  plan: Plan;
  carLimit: number;
  billingCycle: BillingCycle;
  currentPrice: number;
  companyId: string | null;
  onApplied: (result: DiscountResult) => void;
  onRemoved: () => void;
  applied: DiscountResult | null;
}> = ({ plan, carLimit, billingCycle, currentPrice, companyId, onApplied, onRemoved, applied }) => {
  const { t } = useTranslation();
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);

  const handleApply = async () => {
    if (!code.trim()) return;
    setLoading(true);
    setMessage(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/validate-discount-code`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${session?.access_token ?? import.meta.env.VITE_SUPABASE_ANON_KEY}`,
            'Apikey': import.meta.env.VITE_SUPABASE_ANON_KEY,
          },
          body: JSON.stringify({
            code: code.trim(),
            plan,
            billing_cycle: billingCycle,
            car_limit: carLimit,
            current_price: currentPrice,
            company_id: companyId ?? 'signup-pending',
          }),
        }
      );
      const data = await res.json();
      // `german_message` is authored by the edge function, not the dictionary —
      // it is displayed exactly as the server phrased it.
      if (data.valid) {
        onApplied({ ...data, code: code.trim().toUpperCase() });
        setMessage({ text: data.german_message, ok: true });
        setCode('');
      } else {
        setMessage({ text: data.german_message, ok: false });
      }
    } catch {
      setMessage({ text: t('signup.discount.validationError'), ok: false });
    } finally {
      setLoading(false);
    }
  };

  if (applied) {
    return (
      <div className="flex items-center justify-between px-3 py-2.5 rounded-xl border" style={{ background: 'rgba(52,211,153,0.07)', borderColor: 'rgba(52,211,153,0.25)' }}>
        <div className="flex items-center gap-2">
          <Tag size={14} style={{ color: '#34d399' }} />
          <span className="text-xs font-bold" style={{ color: '#34d399' }}>{applied.code}</span>
          <span className="text-xs text-white/40">{t('signup.discount.applied')}</span>
        </div>
        <button onClick={() => { onRemoved(); setMessage(null); }} className="p-1 rounded hover:opacity-70 transition-opacity" style={{ color: '#34d399' }}>
          <X size={14} />
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Tag className="absolute left-3 top-1/2 -translate-y-1/2 text-white/25" size={14} />
          <input
            type="text"
            value={code}
            onChange={e => setCode(e.target.value.toUpperCase())}
            onKeyDown={e => e.key === 'Enter' && handleApply()}
            placeholder={t('signup.discount.label')}
            className="w-full pl-9 pr-3 py-2.5 bg-white/5 border border-white/10 text-white placeholder-white/20 rounded-xl focus:outline-none focus:ring-2 focus:ring-cyan-500/30 text-sm font-mono"
          />
        </div>
        <button
          onClick={handleApply}
          disabled={loading || !code.trim()}
          className="px-4 py-2.5 rounded-xl text-sm font-semibold text-white transition-all disabled:opacity-40 disabled:cursor-not-allowed"
          style={{ background: 'rgba(6,182,212,0.2)', border: '1px solid rgba(6,182,212,0.3)' }}
        >
          {loading ? '…' : t('signup.discount.apply')}
        </button>
      </div>
      {message && (
        <p className="text-xs flex items-center gap-1.5" style={{ color: message.ok ? '#34d399' : '#f87171' }}>
          {message.ok ? <Check size={11} /> : <AlertCircle size={11} />}
          {message.text}
        </p>
      )}
    </div>
  );
};

// ─── Component ────────────────────────────────────────────────────────────────

const SignupPage: React.FC = () => {
  // Prices and the trial length come from the database (plan 3.9), so the
  // screen quotes what the database will charge and what a signup will grant.
  const { priceBook, trialDays } = useAppConfig();
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

  const trialEndDate = new Date();
  trialEndDate.setDate(trialEndDate.getDate() + trialDays);
  const trialEndFormatted = trialEndDate.toLocaleDateString('de-DE', {
    day: '2-digit', month: 'long', year: 'numeric',
  });

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

  const selectedPlanDef = PLANS.find(p => p.id === selectedPlan)!;

  return (
    <div className="min-h-screen bg-[#060a0f] flex items-center justify-center p-4 relative overflow-hidden">
      <div className="absolute inset-0 bg-[linear-gradient(rgba(6,182,212,0.03)_1px,transparent_1px),linear-gradient(90deg,rgba(6,182,212,0.03)_1px,transparent_1px)] bg-[size:48px_48px]" />
      <div className="absolute top-1/4 left-1/2 -translate-x-1/2 w-[600px] h-[400px] bg-cyan-600/5 rounded-full blur-[120px] pointer-events-none" />

      <div className="relative w-full max-w-2xl">
        {/* Logo */}
        <div className="text-center mb-6">
          <div className="w-14 h-14 mx-auto mb-3 flex items-center justify-center">
            <img src="/professor_logo_white.svg" alt="El-Professor" className="w-14 h-14 object-contain drop-shadow-[0_0_16px_rgba(6,182,212,0.5)]" />
          </div>
          <h1 className="text-2xl font-bold text-white mb-1">{t('signup.cta')}</h1>
          <p className="text-white/40 text-sm">{t('signup.subtitle', { days: trialDays })}</p>
        </div>

        {/* Step indicators */}
        <div className="flex items-center justify-center gap-2 mb-6">
          {STEPS.map((s, i) => (
            <React.Fragment key={s}>
              <div className="flex items-center gap-1.5" aria-current={step === s ? 'step' : undefined}>
                <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold transition-all ${
                  step === s
                    ? 'bg-cyan-500 text-white'
                    : i < stepIndex
                      ? 'bg-emerald-500 text-white'
                      : 'bg-white/10 text-white/30'
                }`}>
                  {i < stepIndex ? <Check size={12} aria-hidden="true" /> : i + 1}
                </div>
                <span className={`text-xs font-medium hidden sm:inline ${step === s ? 'text-white' : 'text-white/30'}`}>
                  {t(STEP_LABEL_KEYS[s])}
                </span>
              </div>
              {i < STEPS.length - 1 && <div className={`w-6 h-px ${i < stepIndex ? 'bg-emerald-500/50' : 'bg-white/10'}`} />}
            </React.Fragment>
          ))}
        </div>

        <div className="bg-white/4 backdrop-blur-xl border border-white/10 rounded-2xl p-6 shadow-[0_24px_64px_rgba(0,0,0,0.5)]">

          {/* ── Step 4: Confirm the email address ── */}
          {step === 'verify' && (
            <div className="space-y-5">
              <div>
                <h2 className="text-base font-semibold text-white mb-1">{t('signup.verify.heading')}</h2>
                <p className="text-xs text-white/40 break-words">
                  <EmphasizedText
                    template={t('signup.verify.subheading')}
                    placeholder="email"
                    value={normalizeEmail(email)}
                    className="text-cyan-300"
                  />
                </p>
              </div>

              <div className="w-full max-w-sm mx-auto">
                {verifiedWithoutSession ? (
                  <div className="space-y-4">
                    <NoticeBox tone="success" announce>{t('signup.verify.verifiedLogin')}</NoticeBox>
                    <Link to="/login" replace className={authPrimaryButtonClass}>
                      <LogIn size={15} aria-hidden="true" />
                      <span>{t('auth.signIn')}</span>
                    </Link>
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
            <div className="space-y-5">
              <div>
                <h2 className="text-base font-semibold text-white mb-1">{t('signup.plan.heading')}</h2>
                <p className="text-xs text-white/40">{t('signup.plan.subheading', { days: trialDays })}</p>
              </div>

              {/* Plan cards */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                {PLANS.map(plan => (
                  <button
                    key={plan.id}
                    type="button"
                    onClick={() => { setSelectedPlan(plan.id); setAppliedDiscount(null); }}
                    className="relative text-left p-4 rounded-xl border transition-all"
                    style={{
                      background: selectedPlan === plan.id ? `${plan.color}18` : 'rgba(255,255,255,0.03)',
                      borderColor: selectedPlan === plan.id ? plan.color : 'rgba(255,255,255,0.1)',
                      boxShadow: selectedPlan === plan.id ? `0 0 24px ${plan.color}25` : 'none',
                    }}
                  >
                    {plan.highlight && (
                      <div
                        className="absolute -top-2.5 left-1/2 -translate-x-1/2 px-2 py-0.5 rounded-full text-[10px] font-bold"
                        style={{ background: plan.color, color: '#000' }}
                      >
                        {t('signup.plan.badgePopular')}
                      </div>
                    )}
                    {selectedPlan === plan.id && (
                      <div className="absolute top-2.5 right-2.5 w-5 h-5 rounded-full flex items-center justify-center" style={{ background: plan.color }}>
                        <Check size={11} color="#fff" />
                      </div>
                    )}
                    <p className="font-bold text-white text-sm mb-0.5">{plan.name}</p>
                    <p className="text-xs mb-1" style={{ color: plan.color }}>
                      {fmtPricePerCar(priceBook.price_per_car_cents[plan.id])} €<span className="text-white/30"> {t('landing.pricing.perVehiclePerMonth')}</span>
                    </p>
                    <ul className="space-y-1">
                      {plan.features.map(featureKey => (
                        <li key={featureKey} className="flex items-center gap-1.5 text-xs text-white/50">
                          <span className="w-1 h-1 rounded-full flex-shrink-0" style={{ background: plan.color }} />
                          {t(featureKey)}
                        </li>
                      ))}
                    </ul>
                  </button>
                ))}
              </div>

              {/* Car count */}
              <div>
                <label className={labelClass}>
                  <Car size={11} className="inline mr-1" />
                  {t('signup.cars.label')}
                </label>
                <div className="flex items-center gap-4">
                  <input
                    type="range" min={1} max={20} value={carLimit}
                    onChange={e => { setCarLimit(Number(e.target.value)); setAppliedDiscount(null); }}
                    className="flex-1"
                    style={{ accentColor: selectedPlanDef.color }}
                  />
                  <span className="text-white font-bold text-lg w-8 text-center">{carLimit}</span>
                </div>
                <p className="text-[11px] text-white/30 mt-1">
                  {t('signup.cars.driverLimit', { count: carLimit * 4 })}
                  {fleetDiscountPercent(priceBook, carLimit) > 0 && (
                    <span className="ml-2 text-emerald-400 font-semibold">
                      -{fleetDiscountPercent(priceBook, carLimit)}% {t('landing.pricing.fleetDiscount')}
                    </span>
                  )}
                </p>
              </div>

              {/* Billing cycle */}
              <div>
                <label className={labelClass}>{t('signup.billing.label')}</label>
                <div className="flex gap-2">
                  {(['monthly', 'yearly'] as BillingCycle[]).map(bc => (
                    <button
                      key={bc}
                      type="button"
                      onClick={() => { setBillingCycle(bc); setAppliedDiscount(null); }}
                      className="flex-1 py-2.5 px-3 rounded-xl border text-xs font-semibold transition-all flex items-center justify-center gap-2"
                      style={{
                        background: billingCycle === bc ? `${selectedPlanDef.color}18` : 'rgba(255,255,255,0.03)',
                        borderColor: billingCycle === bc ? selectedPlanDef.color : 'rgba(255,255,255,0.1)',
                        color: billingCycle === bc ? '#fff' : 'rgba(255,255,255,0.4)',
                      }}
                    >
                      {bc === 'monthly' ? t('landing.pricing.monthly') : (
                        <><span>{t('landing.pricing.yearly')}</span>
                          <span className="px-1.5 py-0.5 rounded-full text-[10px]" style={{ background: 'rgba(251,191,36,0.15)', color: '#fbbf24' }}>
                            -{priceBook.yearly_discount_percent}%
                          </span>
                        </>
                      )}
                    </button>
                  ))}
                </div>
              </div>

              {/* Discount code */}
              {(() => {
                const bp = calcPricing(priceBook, selectedPlan, carLimit, billingCycle);
                return (
                  <DiscountCodeInput
                    plan={selectedPlan}
                    carLimit={carLimit}
                    billingCycle={billingCycle}
                    currentPrice={bp.finalTotal}
                    companyId={null}
                    applied={appliedDiscount}
                    onApplied={r => setAppliedDiscount(r)}
                    onRemoved={() => setAppliedDiscount(null)}
                  />
                );
              })()}

              {/* Price preview */}
              <PricePreview plan={selectedPlan} carLimit={carLimit} billingCycle={billingCycle} discount={appliedDiscount} />

              {/* Trial callout */}
              <div className="p-3.5 rounded-xl border border-cyan-500/20 bg-cyan-500/5 flex items-start gap-2.5">
                <Zap size={14} className="text-cyan-400 flex-shrink-0 mt-0.5" />
                <p className="text-xs text-white/50">
                  <span className="text-cyan-300 font-semibold">{t('signup.trial.badge', { days: trialDays })}</span>{' '}
                  {t('signup.trial.bodyLead', { date: trialEndFormatted })}{' '}
                  <span className="text-white/70">Premium</span>{t('signup.trial.bodyTail')}
                </p>
              </div>

              <button
                onClick={() => setStep('company')}
                className="w-full bg-gradient-to-r from-cyan-500 to-blue-600 text-white py-3 px-4 rounded-xl font-semibold text-sm hover:shadow-[0_4px_24px_rgba(6,182,212,0.4)] hover:-translate-y-0.5 transition-all duration-200 flex items-center justify-center gap-2"
              >
                {t('signup.continueWith', { plan: selectedPlanDef.name })}
                <ArrowRight size={15} />
              </button>
            </div>
          )}

          {/* ── Step 2: Company ── */}
          {step === 'company' && (
            <form onSubmit={e => { e.preventDefault(); if (companyName.trim()) setStep('account'); }} className="space-y-5">
              <div>
                <button type="button" onClick={() => setStep('plan')} className="flex items-center gap-1.5 text-white/40 hover:text-white/70 text-xs mb-4 transition-colors">
                  <ArrowLeft size={13} />
                  {selectedPlanDef.name} · {carLimit} {t('signup.vehiclesUnit')}
                </button>
                <h2 className="text-base font-semibold text-white mb-1">{t('signup.company.heading')}</h2>
                <p className="text-xs text-white/40 mb-4">{t('signup.company.subheading')}</p>
              </div>
              <div>
                <label className={labelClass}>{t('signup.company.nameLabel')}</label>
                <div className="relative">
                  <Building2 className="absolute left-3.5 top-1/2 -translate-y-1/2 text-white/25" size={16} />
                  <input
                    type="text"
                    value={companyName}
                    onChange={e => setCompanyName(e.target.value)}
                    className={`${inputClass} pl-10`}
                    placeholder={t('signup.company.namePlaceholder')}
                    required
                    autoFocus
                  />
                </div>
              </div>
              <button
                type="submit"
                disabled={!companyName.trim()}
                className="w-full bg-gradient-to-r from-cyan-500 to-blue-600 text-white py-3 px-4 rounded-xl font-semibold text-sm hover:shadow-[0_4px_24px_rgba(6,182,212,0.4)] hover:-translate-y-0.5 transition-all duration-200 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:translate-y-0 flex items-center justify-center gap-2"
              >
                {t('signup.next')}
                <ArrowRight size={15} />
              </button>
            </form>
          )}

          {/* ── Step 3: Account ── */}
          {step === 'account' && (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <button type="button" onClick={() => { setStep('company'); setError(''); }} className="flex items-center gap-1.5 text-white/40 hover:text-white/70 text-xs mb-4 transition-colors">
                  <ArrowLeft size={13} />
                  {companyName}
                </button>
                <h2 className="text-base font-semibold text-white mb-1">{t('signup.account.heading')}</h2>
                <p className="text-xs text-white/40 mb-4">{t('signup.account.subheading')}</p>
              </div>

              {error && (
                <div className="p-3.5 bg-red-500/10 border border-red-500/20 rounded-xl flex items-start gap-2.5">
                  <AlertCircle className="text-red-400 flex-shrink-0 mt-0.5" size={15} />
                  <span className="text-red-300 text-sm">{error}</span>
                </div>
              )}

              <div>
                <label className={labelClass}>{t('signup.account.fullName')}</label>
                <div className="relative">
                  <User className="absolute left-3.5 top-1/2 -translate-y-1/2 text-white/25" size={16} />
                  <input type="text" value={fullName} onChange={e => setFullName(e.target.value)} className={`${inputClass} pl-10`} placeholder={t('signup.account.fullNamePlaceholder')} required />
                </div>
              </div>

              <div>
                <label className={labelClass}>{t('auth.email')}</label>
                <div className="relative">
                  <Mail className="absolute left-3.5 top-1/2 -translate-y-1/2 text-white/25" size={16} />
                  <input type="email" value={email} onChange={e => setEmail(e.target.value)} className={`${inputClass} pl-10`} placeholder={t('signup.account.emailPlaceholder')} required />
                </div>
              </div>

              <div>
                <label className={labelClass}>{t('auth.password')}</label>
                <div className="relative">
                  <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 text-white/25" size={16} />
                  <input
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    className={`${inputClass} pl-10 pr-12`}
                    placeholder={t('signup.account.passwordPlaceholder')}
                    required
                    minLength={8}
                  />
                  <button type="button" onClick={() => setShowPassword(v => !v)} className="absolute right-3.5 top-1/2 -translate-y-1/2 text-white/25 hover:text-white/60 transition-colors">
                    {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </div>

              <div>
                <label className={labelClass}>
                  <Gift size={11} className="inline mr-1" />
                  {t('signup.account.referralCode')} <span className="text-white/20 normal-case tracking-normal font-normal">{t('signup.optional')}</span>
                </label>
                <div className="relative">
                  <Gift className="absolute left-3.5 top-1/2 -translate-y-1/2 text-white/25" size={16} />
                  <input
                    type="text"
                    value={referralCode}
                    onChange={e => { setReferralCode(e.target.value.toUpperCase()); setReferralError(''); }}
                    className={`${inputClass} pl-10 font-mono`}
                    placeholder={t('signup.account.referralPlaceholder')}
                  />
                </div>
                {referralError && (
                  <p className="mt-1.5 text-xs flex items-center gap-1.5 text-red-400">
                    <AlertCircle size={11} />
                    {referralError}
                  </p>
                )}
              </div>

              <button
                type="submit"
                disabled={loading || !fullName.trim() || !email.trim() || password.length < 8}
                className="w-full bg-gradient-to-r from-cyan-500 to-blue-600 text-white py-3 px-4 rounded-xl font-semibold text-sm hover:shadow-[0_4px_24px_rgba(6,182,212,0.4)] hover:-translate-y-0.5 transition-all duration-200 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:translate-y-0 flex items-center justify-center gap-2 mt-2"
              >
                {loading
                  ? <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white" />
                  : <><CheckCircle2 size={15} />{t('signup.cta')}</>
                }
              </button>

              <p className="text-center text-white/25 text-xs pt-1">
                {t('signup.summaryLead', { days: trialDays })}
                <strong className="text-white/40">{selectedPlanDef.name}</strong>
                {t('signup.summaryTail', {
                  cars: carLimit,
                  cycle: billingCycle === 'yearly' ? t('signup.billing.yearlyAdj') : t('signup.billing.monthlyAdj'),
                })}
              </p>
            </form>
          )}
        </div>

        <p className="text-center mt-5 text-white/30 text-sm">
          {t('signup.alreadyRegistered')}{' '}
          <Link to="/login" className="text-cyan-300/80 hover:text-cyan-200 transition-colors">{t('auth.signIn')}</Link>
        </p>
      </div>
    </div>
  );
};

export default SignupPage;
