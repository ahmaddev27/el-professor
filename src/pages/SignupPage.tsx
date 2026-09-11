import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Building2, User, Mail, Lock, Eye, EyeOff,
  AlertCircle, CheckCircle2, ArrowLeft, ArrowRight, Zap, Check, Car, Tag, X, Gift,
} from 'lucide-react';
import { supabase } from '../lib/supabase';
import { Plan } from '../contexts/PlanContext';
import { calcPricing, fleetDiscountPercent, PRICE_PER_CAR, YEARLY_DISCOUNT_PERCENT, fmt as fmtPrice } from '../utils/pricing';
import type { BillingCycle, DiscountResult } from '../utils/pricing';

type Step = 'plan' | 'company' | 'account' | 'done';

const TRIAL_DAYS = 14;

const inputClass =
  'w-full px-4 py-3 bg-white/5 border border-white/10 text-white placeholder-white/20 rounded-xl focus:outline-none focus:ring-2 focus:ring-cyan-500/50 focus:border-cyan-500/40 transition-all text-sm';
const labelClass = 'block text-xs font-semibold text-white/40 uppercase tracking-wider mb-2';

// ─── Plan definitions ─────────────────────────────────────────────────────────

interface PlanDef {
  id: Plan;
  name: string;
  sub: string;
  highlight: boolean;
  color: string;
  features: string[];
}

const PLANS: PlanDef[] = [
  {
    id: 'basic',
    name: 'Basic',
    sub: 'Grundfunktionen für Ihre Flotte.',
    highlight: false,
    color: '#06b6d4',
    features: ['Übersicht', 'Belege', 'Fahrer', 'Fahrzeuge', 'Umsätze', 'Fixkosten', 'Bargeldbestand'],
  },
  {
    id: 'advanced',
    name: 'Advanced',
    sub: 'Für wachsende Unternehmen.',
    highlight: true,
    color: '#f59e0b',
    features: ['Alles aus Basic', 'Werkstatt', 'Abrechnung', 'Notizen', 'Rollen & Nutzer'],
  },
  {
    id: 'premium',
    name: 'Premium',
    sub: 'Für professionelle Fuhrparks.',
    highlight: false,
    color: '#10b981',
    features: ['Alles aus Advanced', 'Gehälter', 'Dokumente', 'Stundennachweis'],
  },
];

const STEPS: Step[] = ['plan', 'company', 'account'];

// ─── PricePreview ─────────────────────────────────────────────────────────────

const PricePreview: React.FC<{
  plan: Plan;
  carLimit: number;
  billingCycle: BillingCycle;
  discount?: DiscountResult | null;
}> = ({ plan, carLimit, billingCycle, discount }) => {
  const bp = calcPricing(plan, carLimit, billingCycle);
  const fleetPct = fleetDiscountPercent(carLimit);
  const planColor = PLANS.find(p => p.id === plan)?.color ?? '#06b6d4';

  // current_price that was passed to edge fn = bp.finalTotal
  const finalPrice = discount ? discount.final_price : bp.finalTotal;

  return (
    <div className="rounded-xl p-4 border" style={{
      background: `${planColor}0d`,
      borderColor: `${planColor}30`,
    }}>
      <p className="text-xs font-semibold uppercase tracking-wider mb-3" style={{ color: planColor }}>
        Ihre Preisübersicht
      </p>
      <div className="space-y-1.5 text-xs">
        <div className="flex justify-between text-white/50">
          <span>Grundpreis ({carLimit} × {PRICE_PER_CAR[plan]} €)</span>
          <span>{fmtPrice(bp.baseMonthly)} €</span>
        </div>
        {fleetPct > 0 && (
          <div className="flex justify-between" style={{ color: '#34d399' }}>
            <span>Flottenrabatt -{fleetPct}%</span>
            <span>-{fmtPrice(bp.baseMonthly - bp.monthlyAfterFleet)} €</span>
          </div>
        )}
        {billingCycle === 'yearly' && (
          <div className="flex justify-between" style={{ color: '#fbbf24' }}>
            <span>Jahresrabatt -{YEARLY_DISCOUNT_PERCENT}%</span>
            <span>
              -{fmtPrice(billingCycle === 'yearly' ? bp.monthlyAfterFleet * 12 - bp.yearlyTotal : 0)} €
            </span>
          </div>
        )}
        {discount && (
          <div className="flex justify-between" style={{ color: '#34d399' }}>
            <span>Rabattcode ({discount.code})</span>
            <span>-{fmtPrice(discount.discount_amount)} €</span>
          </div>
        )}
        <div className="pt-2 border-t border-white/10 flex justify-between font-bold" style={{ color: planColor }}>
          {billingCycle === 'yearly' ? (
            <>
              <span>Endpreis (jährlich)</span>
              <span>{fmtPrice(finalPrice)} €</span>
            </>
          ) : (
            <>
              <span>Endpreis (monatlich)</span>
              <span>{fmtPrice(finalPrice)} €</span>
            </>
          )}
        </div>
        {billingCycle === 'yearly' && (
          <div className="flex justify-between text-white/35 text-[11px]">
            <span>Monatliches Äquivalent</span>
            <span>{fmtPrice(finalPrice / 12)} € / Monat</span>
          </div>
        )}
      </div>
      <p className="text-[10px] text-white/25 mt-3">
        Fahrerlimit: {carLimit * 4} aktive Fahrer (4× Fahrzeuge)
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
      if (data.valid) {
        onApplied({ ...data, code: code.trim().toUpperCase() });
        setMessage({ text: data.german_message, ok: true });
        setCode('');
      } else {
        setMessage({ text: data.german_message, ok: false });
      }
    } catch {
      setMessage({ text: 'Fehler bei der Validierung.', ok: false });
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
          <span className="text-xs text-white/40">angewendet</span>
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
            placeholder="Rabattcode"
            className="w-full pl-9 pr-3 py-2.5 bg-white/5 border border-white/10 text-white placeholder-white/20 rounded-xl focus:outline-none focus:ring-2 focus:ring-cyan-500/30 text-sm font-mono"
          />
        </div>
        <button
          onClick={handleApply}
          disabled={loading || !code.trim()}
          className="px-4 py-2.5 rounded-xl text-sm font-semibold text-white transition-all disabled:opacity-40 disabled:cursor-not-allowed"
          style={{ background: 'rgba(6,182,212,0.2)', border: '1px solid rgba(6,182,212,0.3)' }}
        >
          {loading ? '…' : 'Anwenden'}
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

  const stepIndex = STEPS.indexOf(step as any);

  const trialEndDate = new Date();
  trialEndDate.setDate(trialEndDate.getDate() + TRIAL_DAYS);
  const trialEndFormatted = trialEndDate.toLocaleDateString('de-DE', {
    day: '2-digit', month: 'long', year: 'numeric',
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setReferralError('');
    if (password.length < 8) {
      setError('Das Passwort muss mindestens 8 Zeichen lang sein.');
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
            // The server redeems it against a locked row and computes the
            // price itself; anything we sent about the amount was advisory and
            // is now ignored.
            discount_code: appliedDiscount?.code ?? null,
            referral_code: referralCode.trim() || null,
          }),
        }
      );
      const data = await res.json();
      if (!res.ok || !data.success) {
        const errMsg: string = data.error || '';
        if (errMsg.toLowerCase().includes('bereits registriert') || errMsg.toLowerCase().includes('already')) {
          setError('Diese E-Mail-Adresse ist bereits registriert. Bitte melden Sie sich an oder setzen Sie Ihr Passwort zurück.');
        } else if (errMsg.toLowerCase().includes('empfehlungscode') || errMsg.toLowerCase().includes('referral')) {
          setReferralError(errMsg);
        } else {
          setError(errMsg || 'Registrierung fehlgeschlagen. Bitte versuchen Sie es erneut.');
        }
        return;
      }
      // Account created — sign in and let the app show the pending approval page
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });
      if (signInError) {
        setStep('done');
        return;
      }
      // AuthContext will detect approval_status=pending and render PendingApprovalPage
      window.location.href = '/overview';
    } catch {
      setError('Ein unerwarteter Fehler ist aufgetreten. Bitte versuchen Sie es erneut.');
    } finally {
      setLoading(false);
    }
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
          <h1 className="text-2xl font-bold text-white mb-1">Kostenlos starten</h1>
          <p className="text-white/40 text-sm">{TRIAL_DAYS} Tage kostenlos testen — keine Kreditkarte erforderlich</p>
        </div>

        {/* Step indicators */}
        {step !== 'done' && (
          <div className="flex items-center justify-center gap-2 mb-6">
            {(['plan', 'company', 'account'] as Step[]).map((s, i) => (
              <React.Fragment key={s}>
                <div className="flex items-center gap-1.5">
                  <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold transition-all ${
                    step === s
                      ? 'bg-cyan-500 text-white'
                      : i < stepIndex
                        ? 'bg-emerald-500 text-white'
                        : 'bg-white/10 text-white/30'
                  }`}>
                    {i < stepIndex ? <Check size={12} /> : i + 1}
                  </div>
                  <span className={`text-xs font-medium hidden sm:inline ${step === s ? 'text-white' : 'text-white/30'}`}>
                    {s === 'plan' ? 'Plan' : s === 'company' ? 'Unternehmen' : 'Zugangsdaten'}
                  </span>
                </div>
                {i < 2 && <div className={`w-6 h-px ${i < stepIndex ? 'bg-emerald-500/50' : 'bg-white/10'}`} />}
              </React.Fragment>
            ))}
          </div>
        )}

        <div className="bg-white/4 backdrop-blur-xl border border-white/10 rounded-2xl p-6 shadow-[0_24px_64px_rgba(0,0,0,0.5)]">

          {/* ── Done ── */}
          {step === 'done' && (
            <div className="text-center py-4">
              <div className="w-14 h-14 rounded-full bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center mx-auto mb-4">
                <CheckCircle2 className="text-emerald-400" size={26} />
              </div>
              <h2 className="text-white font-semibold mb-2">Konto erfolgreich erstellt</h2>
              <p className="text-white/60 text-sm leading-relaxed mb-6">
                Ihr Konto wurde erstellt. Sie k&ouml;nnen sich jetzt anmelden.
              </p>
              <Link to="/login" className="inline-flex items-center justify-center gap-2 w-full bg-gradient-to-r from-cyan-500 to-blue-600 text-white py-3 px-4 rounded-xl font-semibold text-sm">
                Zur Anmeldung
              </Link>
            </div>
          )}

          {/* ── Step 1: Plan + Car Count + Billing Cycle ── */}
          {step === 'plan' && (
            <div className="space-y-5">
              <div>
                <h2 className="text-base font-semibold text-white mb-1">Tarif auswählen</h2>
                <p className="text-xs text-white/40">Alle Tarife starten mit {TRIAL_DAYS} Tagen kostenlos — Sie können jederzeit wechseln.</p>
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
                        Beliebt
                      </div>
                    )}
                    {selectedPlan === plan.id && (
                      <div className="absolute top-2.5 right-2.5 w-5 h-5 rounded-full flex items-center justify-center" style={{ background: plan.color }}>
                        <Check size={11} color="#fff" />
                      </div>
                    )}
                    <p className="font-bold text-white text-sm mb-0.5">{plan.name}</p>
                    <p className="text-xs mb-1" style={{ color: plan.color }}>
                      {PRICE_PER_CAR[plan.id]} €<span className="text-white/30"> / Fahrzeug / Monat</span>
                    </p>
                    <ul className="space-y-1">
                      {plan.features.map(f => (
                        <li key={f} className="flex items-center gap-1.5 text-xs text-white/50">
                          <span className="w-1 h-1 rounded-full flex-shrink-0" style={{ background: plan.color }} />
                          {f}
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
                  Anzahl Fahrzeuge
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
                  Fahrerlimit: {carLimit * 4} aktive Fahrer
                  {fleetDiscountPercent(carLimit) > 0 && (
                    <span className="ml-2 text-emerald-400 font-semibold">
                      -{fleetDiscountPercent(carLimit)}% Flottenrabatt
                    </span>
                  )}
                </p>
              </div>

              {/* Billing cycle */}
              <div>
                <label className={labelClass}>Abrechnung</label>
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
                      {bc === 'monthly' ? 'Monatlich' : (
                        <><span>Jährlich</span>
                          <span className="px-1.5 py-0.5 rounded-full text-[10px]" style={{ background: 'rgba(251,191,36,0.15)', color: '#fbbf24' }}>
                            -{YEARLY_DISCOUNT_PERCENT}%
                          </span>
                        </>
                      )}
                    </button>
                  ))}
                </div>
              </div>

              {/* Discount code */}
              {(() => {
                const bp = calcPricing(selectedPlan, carLimit, billingCycle);
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
                  <span className="text-cyan-300 font-semibold">{TRIAL_DAYS} Tage kostenlos:</span>{' '}
                  Während Ihrer Testphase (bis {trialEndFormatted}) haben Sie Zugriff auf alle{' '}
                  <span className="text-white/70">Premium</span>-Features — unabhängig vom gewählten Tarif.
                </p>
              </div>

              <button
                onClick={() => setStep('company')}
                className="w-full bg-gradient-to-r from-cyan-500 to-blue-600 text-white py-3 px-4 rounded-xl font-semibold text-sm hover:shadow-[0_4px_24px_rgba(6,182,212,0.4)] hover:-translate-y-0.5 transition-all duration-200 flex items-center justify-center gap-2"
              >
                Weiter mit {selectedPlanDef.name}
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
                  {selectedPlanDef.name} · {carLimit} Fahrzeuge
                </button>
                <h2 className="text-base font-semibold text-white mb-1">Ihr Unternehmen</h2>
                <p className="text-xs text-white/40 mb-4">Wie heißt Ihr Unternehmen?</p>
              </div>
              <div>
                <label className={labelClass}>Unternehmensname</label>
                <div className="relative">
                  <Building2 className="absolute left-3.5 top-1/2 -translate-y-1/2 text-white/25" size={16} />
                  <input
                    type="text"
                    value={companyName}
                    onChange={e => setCompanyName(e.target.value)}
                    className={`${inputClass} pl-10`}
                    placeholder="Muster GmbH"
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
                Weiter
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
                <h2 className="text-base font-semibold text-white mb-1">Ihr Zugang</h2>
                <p className="text-xs text-white/40 mb-4">Sie werden der erste Administrator des Unternehmens.</p>
              </div>

              {error && (
                <div className="p-3.5 bg-red-500/10 border border-red-500/20 rounded-xl flex items-start gap-2.5">
                  <AlertCircle className="text-red-400 flex-shrink-0 mt-0.5" size={15} />
                  <span className="text-red-300 text-sm">{error}</span>
                </div>
              )}

              <div>
                <label className={labelClass}>Vollständiger Name</label>
                <div className="relative">
                  <User className="absolute left-3.5 top-1/2 -translate-y-1/2 text-white/25" size={16} />
                  <input type="text" value={fullName} onChange={e => setFullName(e.target.value)} className={`${inputClass} pl-10`} placeholder="Max Mustermann" required />
                </div>
              </div>

              <div>
                <label className={labelClass}>E-Mail-Adresse</label>
                <div className="relative">
                  <Mail className="absolute left-3.5 top-1/2 -translate-y-1/2 text-white/25" size={16} />
                  <input type="email" value={email} onChange={e => setEmail(e.target.value)} className={`${inputClass} pl-10`} placeholder="max@muster-gmbh.de" required />
                </div>
              </div>

              <div>
                <label className={labelClass}>Passwort</label>
                <div className="relative">
                  <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 text-white/25" size={16} />
                  <input
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    className={`${inputClass} pl-10 pr-12`}
                    placeholder="Mindestens 8 Zeichen"
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
                  Empfehlungscode <span className="text-white/20 normal-case tracking-normal font-normal">(optional)</span>
                </label>
                <div className="relative">
                  <Gift className="absolute left-3.5 top-1/2 -translate-y-1/2 text-white/25" size={16} />
                  <input
                    type="text"
                    value={referralCode}
                    onChange={e => { setReferralCode(e.target.value.toUpperCase()); setReferralError(''); }}
                    className={`${inputClass} pl-10 font-mono`}
                    placeholder="z.B. PARTNER2024"
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
                  : <><CheckCircle2 size={15} />Kostenlos starten</>
                }
              </button>

              <p className="text-center text-white/25 text-xs pt-1">
                {TRIAL_DAYS} Tage kostenlos, danach <strong className="text-white/40">{selectedPlanDef.name}</strong> ·{' '}
                {carLimit} Fahrzeuge · {billingCycle === 'yearly' ? 'jährliche' : 'monatliche'} Abrechnung.
              </p>
            </form>
          )}
        </div>

        <p className="text-center mt-5 text-white/30 text-sm">
          Bereits registriert?{' '}
          <Link to="/login" className="text-cyan-300/80 hover:text-cyan-200 transition-colors">Anmelden</Link>
        </p>
      </div>
    </div>
  );
};

export default SignupPage;
