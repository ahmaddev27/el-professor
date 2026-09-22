import React, { useState } from 'react';
import { AlertCircle, Car, Check, Tag, X, Zap } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { Plan } from '../../contexts/PlanContext';
import { calcPricing, fleetDiscountPercent, fmtPricePerCar, fmt as fmtPrice } from '../../utils/pricing';
import type { BillingCycle, DiscountResult } from '../../utils/pricing';
import { useAppConfig } from '../../contexts/AppConfigContext';
import { useTranslation } from '../../contexts/LanguageContext';
import { PLANS, planDef } from './plans';
import { Badge, Button, Input, cn } from '../ui';

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

  // current_price that was passed to edge fn = bp.finalTotal
  const finalPrice = discount ? discount.final_price : bp.finalTotal;

  // ── Presentation (phase 5) ────────────────────────────────────────────────
  // The figures are the ones above and the expressions below, unchanged; only
  // how they are drawn moved to the design system. Every discount reads as a
  // gain in the one positive colour, and the tier's name, which used to be
  // told by the box's colour, is written in its heading.

  return (
    <div className="rounded-surface border border-line bg-sunken p-4 font-ui">
      <p className="mb-3 text-[13px] font-semibold text-fg">
        {t('signup.price.heading')} · {planDef(plan).name}
      </p>
      <div className="grid gap-1.5 text-xs tabular-nums">
        <div className="flex justify-between gap-3 text-fg-muted">
          <span>{t('signup.price.base')} ({carLimit} × {fmtPricePerCar(priceBook.price_per_car_cents[plan])} €)</span>
          <span>{fmtPrice(bp.baseMonthly)} €</span>
        </div>
        {fleetPct > 0 && (
          <div className="flex justify-between gap-3 text-positive">
            <span>{t('landing.pricing.fleetDiscount')} -{fleetPct}%</span>
            <span>-{fmtPrice(bp.baseMonthly - bp.monthlyAfterFleet)} €</span>
          </div>
        )}
        {billingCycle === 'yearly' && (
          <div className="flex justify-between gap-3 text-positive">
            <span>{t('landing.pricing.yearlyDiscount')} -{priceBook.yearly_discount_percent}%</span>
            <span>
              -{fmtPrice(billingCycle === 'yearly' ? bp.monthlyAfterFleet * 12 - bp.yearlyTotal : 0)} €
            </span>
          </div>
        )}
        {discount && (
          <div className="flex justify-between gap-3 text-positive">
            <span>{t('signup.discount.label')} ({discount.code})</span>
            <span>-{fmtPrice(discount.discount_amount)} €</span>
          </div>
        )}
        <div className="mt-1 flex justify-between gap-3 border-t border-line pt-2 text-sm font-semibold text-fg">
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
          <div className="flex justify-between gap-3 text-fg-subtle">
            <span>{t('signup.price.monthlyEquivalent')}</span>
            <span>{fmtPrice(finalPrice / 12)} € {t('signup.price.perMonth')}</span>
          </div>
        )}
      </div>
      <p className="mt-3 text-xs text-fg-subtle">
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

  // ── Presentation (phase 5) ────────────────────────────────────────────────
  // The check above is unchanged, and so is when it runs: the button, and
  // Enter in the field. The server's own sentence is shown as it arrives.
  //
  // The two buttons are `type="submit"` on purpose: the legacy ones named no
  // type, and a button without one submits the form it sits in. On the Google
  // registration screen this block sits inside that screen's form, so
  // "Anwenden" and removing a code have always submitted the registration as
  // well — a defect, recorded in HANDOFF.md for the owner, and not this
  // look-only change's to fix. The design-system Button defaults to "button",
  // so the old behaviour has to be asked for.

  if (applied) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-control border border-positive/30 bg-positive-soft px-3 py-2 font-ui">
        <div className="flex min-w-0 items-center gap-2 text-xs">
          <Tag aria-hidden className="size-3.5 shrink-0 text-positive" />
          <span className="font-semibold text-positive">{applied.code}</span>
          <span className="text-fg-muted">{t('signup.discount.applied')}</span>
        </div>
        <Button
          type="submit"
          variant="ghost"
          size="icon-sm"
          onClick={() => { onRemoved(); setMessage(null); }}
          aria-label={t('common.remove')}
          className="text-positive hover:text-positive"
        >
          <X aria-hidden />
        </Button>
      </div>
    );
  }

  return (
    <div className="grid gap-2 font-ui">
      <div className="flex gap-2">
        <div className="relative min-w-0 flex-1">
          <Tag aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-fg-subtle" />
          <Input
            type="text"
            value={code}
            onChange={e => setCode(e.target.value.toUpperCase())}
            onKeyDown={e => e.key === 'Enter' && handleApply()}
            placeholder={t('signup.discount.label')}
            aria-label={t('signup.discount.label')}
            className="pl-8 font-mono"
          />
        </div>
        <Button
          type="submit"
          variant="secondary"
          onClick={handleApply}
          disabled={loading || !code.trim()}
        >
          {loading ? '…' : t('signup.discount.apply')}
        </Button>
      </div>
      {message && (
        <p role="status" className={cn('flex items-center gap-1.5 text-xs', message.ok ? 'text-positive' : 'text-critical')}>
          {message.ok ? <Check aria-hidden className="size-3.5 shrink-0" /> : <AlertCircle aria-hidden className="size-3.5 shrink-0" />}
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

  const trialEndDate = new Date();
  trialEndDate.setDate(trialEndDate.getDate() + trialDays);
  const trialEndFormatted = trialEndDate.toLocaleDateString('de-DE', {
    day: '2-digit', month: 'long', year: 'numeric',
  });

  const breakdown = calcPricing(priceBook, plan, carLimit, billingCycle);

  // ── Presentation (phase 5) ────────────────────────────────────────────────
  // Everything above is unchanged except `selectedPlanDef`, which only looked
  // up the chosen tier's colour for the slider and the cycle buttons; with one
  // brand colour for every tier there is nothing left to look up. Each choice
  // below still drops an applied discount code, as before.

  return (
    <>
      {/* Plan cards */}
      <div className="grid grid-cols-1 gap-3 font-ui sm:grid-cols-3">
        {PLANS.map(entry => (
          <button
            key={entry.id}
            type="button"
            onClick={() => { onPlanChange(entry.id); onDiscountChange(null); }}
            aria-pressed={plan === entry.id}
            className={cn(
              'relative rounded-surface border p-4 text-left transition-colors',
              'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
              plan === entry.id ? 'border-brand bg-brand-soft' : 'border-line bg-raised hover:bg-sunken',
            )}
          >
            {entry.highlight && (
              <Badge tone="brand" className="absolute -top-2.5 left-1/2 -translate-x-1/2 border border-brand/30 bg-raised">
                {t('signup.plan.badgePopular')}
              </Badge>
            )}
            {plan === entry.id && (
              <span className="absolute right-2.5 top-2.5 flex size-5 items-center justify-center rounded-full bg-brand text-brand-fg">
                <Check aria-hidden className="size-3" />
              </span>
            )}
            <p className="mb-0.5 text-sm font-semibold text-fg">{entry.name}</p>
            <p className="mb-2 text-xs tabular-nums text-brand-text">
              {fmtPricePerCar(priceBook.price_per_car_cents[entry.id])} €<span className="text-fg-subtle"> {t('landing.pricing.perVehiclePerMonth')}</span>
            </p>
            <ul className="grid gap-1">
              {entry.features.map(featureKey => (
                <li key={featureKey} className="flex items-center gap-1.5 text-xs text-fg-muted">
                  <span aria-hidden className="size-1 shrink-0 rounded-full bg-fg-subtle" />
                  {t(featureKey)}
                </li>
              ))}
            </ul>
          </button>
        ))}
      </div>

      {/* Car count */}
      <div className="font-ui">
        <label htmlFor="signup-car-limit" className="mb-1.5 flex items-center gap-1.5 text-[13px] font-medium text-fg-muted">
          <Car aria-hidden className="size-3.5" />
          {t('signup.cars.label')}
        </label>
        <div className="flex items-center gap-4">
          <input
            id="signup-car-limit"
            type="range" min={1} max={20} value={carLimit}
            onChange={e => { onCarLimitChange(Number(e.target.value)); onDiscountChange(null); }}
            className="h-11 flex-1 accent-brand"
          />
          <span className="w-8 text-center text-lg font-semibold tabular-nums text-fg">{carLimit}</span>
        </div>
        <p className="mt-1 text-xs text-fg-subtle">
          {t('signup.cars.driverLimit', { count: carLimit * 4 })}
          {fleetDiscountPercent(priceBook, carLimit) > 0 && (
            <span className="ml-2 font-semibold text-positive">
              -{fleetDiscountPercent(priceBook, carLimit)}% {t('landing.pricing.fleetDiscount')}
            </span>
          )}
        </p>
      </div>

      {/* Billing cycle */}
      <div className="font-ui">
        <p className="mb-1.5 text-[13px] font-medium text-fg-muted">{t('signup.billing.label')}</p>
        <div role="group" aria-label={t('signup.billing.label')} className="grid grid-cols-2 gap-2">
          {(['monthly', 'yearly'] as BillingCycle[]).map(bc => (
            <button
              key={bc}
              type="button"
              onClick={() => { onBillingCycleChange(bc); onDiscountChange(null); }}
              aria-pressed={billingCycle === bc}
              className={cn(
                'flex h-10 items-center justify-center gap-2 rounded-control border px-3 text-sm font-semibold transition-colors [@media(pointer:coarse)]:h-11',
                'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
                billingCycle === bc ? 'border-brand bg-brand-soft text-fg' : 'border-line bg-raised text-fg-muted hover:bg-sunken hover:text-fg',
              )}
            >
              {bc === 'monthly' ? t('landing.pricing.monthly') : (
                <><span>{t('landing.pricing.yearly')}</span>
                  <Badge tone="positive">
                    -{priceBook.yearly_discount_percent}%
                  </Badge>
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
        <div className="flex items-start gap-2.5 rounded-surface border border-brand/30 bg-brand-soft p-3.5 font-ui text-xs text-fg-muted">
          <Zap aria-hidden className="mt-0.5 size-3.5 shrink-0 text-brand-text" />
          <p>
            <span className="font-semibold text-brand-text">{t('signup.trial.badge', { days: trialDays })}</span>{' '}
            {t('signup.trial.bodyLead', { date: trialEndFormatted })}{' '}
            <span className="font-medium text-fg">Premium</span>{t('signup.trial.bodyTail')}
          </p>
        </div>
      )}
    </>
  );
};

export default PlanSelection;
