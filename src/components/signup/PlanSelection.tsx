import React, { useState } from 'react';
import { AlertCircle, Car, Check, Tag, X, Zap } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { Plan } from '../../contexts/PlanContext';
import { calcPricing, fleetDiscountPercent, fmtPricePerCar, fmt as fmtPrice } from '../../utils/pricing';
import type { BillingCycle, DiscountResult } from '../../utils/pricing';
import { useAppConfig } from '../../contexts/AppConfigContext';
import { useTranslation } from '../../contexts/LanguageContext';
import { PLANS, planDef } from './plans';

/**
 * Tier, fleet size, billing cycle, discount code and the resulting price — the
 * block both registration paths show.
 *
 * It was step 1 of SignupPage; the Google registration screen (plan 1.6) needs
 * exactly the same choices, and a second copy would be a second price list to
 * keep in step with the database's price book. The markup is unchanged, so the
 * password signup looks and behaves as it did.
 *
 * Any change to the tier, the fleet size or the cycle drops an applied discount
 * code: the code was checked against the price that has just changed.
 */

const labelClass = 'block text-xs font-semibold text-white/40 uppercase tracking-wider mb-2';

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
  const planColor = planDef(plan).color;

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

// ─── PlanSelection ────────────────────────────────────────────────────────────

interface PlanSelectionProps {
  plan: Plan;
  carLimit: number;
  billingCycle: BillingCycle;
  discount: DiscountResult | null;
  onPlanChange: (plan: Plan) => void;
  onCarLimitChange: (carLimit: number) => void;
  onBillingCycleChange: (billingCycle: BillingCycle) => void;
  onDiscountChange: (discount: DiscountResult | null) => void;
  /** Passed on to validate-discount-code; null while no company exists yet. */
  companyId?: string | null;
  /** The trial note under the price. Off where the screen says it elsewhere. */
  showTrialCallout?: boolean;
}

const PlanSelection: React.FC<PlanSelectionProps> = ({
  plan,
  carLimit,
  billingCycle,
  discount,
  onPlanChange,
  onCarLimitChange,
  onBillingCycleChange,
  onDiscountChange,
  companyId = null,
  showTrialCallout = true,
}) => {
  const { t } = useTranslation();
  // Prices and the trial length come from the database (plan 3.9), so the
  // screen quotes what the database will charge and what a signup will grant.
  const { priceBook, trialDays } = useAppConfig();
  const selectedPlanDef = planDef(plan);

  const trialEndDate = new Date();
  trialEndDate.setDate(trialEndDate.getDate() + trialDays);
  const trialEndFormatted = trialEndDate.toLocaleDateString('de-DE', {
    day: '2-digit', month: 'long', year: 'numeric',
  });

  const breakdown = calcPricing(priceBook, plan, carLimit, billingCycle);

  return (
    <>
      {/* Plan cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {PLANS.map(entry => (
          <button
            key={entry.id}
            type="button"
            onClick={() => { onPlanChange(entry.id); onDiscountChange(null); }}
            className="relative text-left p-4 rounded-xl border transition-all"
            style={{
              background: plan === entry.id ? `${entry.color}18` : 'rgba(255,255,255,0.03)',
              borderColor: plan === entry.id ? entry.color : 'rgba(255,255,255,0.1)',
              boxShadow: plan === entry.id ? `0 0 24px ${entry.color}25` : 'none',
            }}
          >
            {entry.highlight && (
              <div
                className="absolute -top-2.5 left-1/2 -translate-x-1/2 px-2 py-0.5 rounded-full text-[10px] font-bold"
                style={{ background: entry.color, color: '#000' }}
              >
                {t('signup.plan.badgePopular')}
              </div>
            )}
            {plan === entry.id && (
              <div className="absolute top-2.5 right-2.5 w-5 h-5 rounded-full flex items-center justify-center" style={{ background: entry.color }}>
                <Check size={11} color="#fff" />
              </div>
            )}
            <p className="font-bold text-white text-sm mb-0.5">{entry.name}</p>
            <p className="text-xs mb-1" style={{ color: entry.color }}>
              {fmtPricePerCar(priceBook.price_per_car_cents[entry.id])} €<span className="text-white/30"> {t('landing.pricing.perVehiclePerMonth')}</span>
            </p>
            <ul className="space-y-1">
              {entry.features.map(featureKey => (
                <li key={featureKey} className="flex items-center gap-1.5 text-xs text-white/50">
                  <span className="w-1 h-1 rounded-full flex-shrink-0" style={{ background: entry.color }} />
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
            onChange={e => { onCarLimitChange(Number(e.target.value)); onDiscountChange(null); }}
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
              onClick={() => { onBillingCycleChange(bc); onDiscountChange(null); }}
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
      <DiscountCodeInput
        plan={plan}
        carLimit={carLimit}
        billingCycle={billingCycle}
        currentPrice={breakdown.finalTotal}
        companyId={companyId}
        applied={discount}
        onApplied={result => onDiscountChange(result)}
        onRemoved={() => onDiscountChange(null)}
      />

      {/* Price preview */}
      <PricePreview plan={plan} carLimit={carLimit} billingCycle={billingCycle} discount={discount} />

      {/* Trial callout */}
      {showTrialCallout && (
        <div className="p-3.5 rounded-xl border border-cyan-500/20 bg-cyan-500/5 flex items-start gap-2.5">
          <Zap size={14} className="text-cyan-400 flex-shrink-0 mt-0.5" />
          <p className="text-xs text-white/50">
            <span className="text-cyan-300 font-semibold">{t('signup.trial.badge', { days: trialDays })}</span>{' '}
            {t('signup.trial.bodyLead', { date: trialEndFormatted })}{' '}
            <span className="text-white/70">Premium</span>{t('signup.trial.bodyTail')}
          </p>
        </div>
      )}
    </>
  );
};

export default PlanSelection;
