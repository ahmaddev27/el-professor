import React, { createContext, useContext, useEffect, useState, useCallback, ReactNode } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from './AuthContext';
import { useAppConfig } from './AppConfigContext';
import { calcPricing, PriceBreakdown, BillingCycle } from '../utils/pricing';
import { minPlanForFeature, planHasFeature } from '../utils/planFeatures';

// ─── Types ────────────────────────────────────────────────────────────────────

export type Plan = 'basic' | 'advanced' | 'premium';
export type SubscriptionStatus = 'trial' | 'active' | 'trial_expired' | 'suspended' | 'inactive' | 'archived' | 'deleted';
export type { BillingCycle };

export interface PlanState {
  plan: Plan;
  status: SubscriptionStatus;
  trialStart: Date | null;
  trialEnd: Date | null;
  trialDaysLeft: number;
  isInTrial: boolean;
  isTrialExpired: boolean;
  isActive: boolean;
  /** Number of cars included in the subscription */
  carLimit: number;
  /** monthly or yearly */
  billingCycle: BillingCycle;
}

export type FeatureKey =
  | 'overview'
  | 'belege'
  | 'fahrer'
  | 'fahrzeuge'
  | 'umsaetze'
  | 'fixkosten'
  | 'bargeldbestand'
  | 'werkstatt'
  | 'abrechnung'
  | 'notizen'
  | 'rollen_nutzer'
  | 'benachrichtigungen'
  | 'gehaelter'
  | 'dokumente'
  | 'trinkgeld_quittung'
  | 'stundennachweis';

interface PlanContextType {
  planState: PlanState;
  loading: boolean;
  can: (feature: FeatureKey) => boolean;
  /**
   * The lowest plan that unlocks a feature, as the database's feature map says.
   * A feature the map does not name needs premium, so a build that knows a
   * feature the database has not heard of locks it rather than opening it.
   */
  minPlanFor: (feature: FeatureKey) => Plan;
  effectivePlan: Plan;
  /** Calculated pricing breakdown based on stored plan + carLimit + billingCycle */
  pricing: PriceBreakdown;
  refresh: () => Promise<void>;
}

// ─── Context ──────────────────────────────────────────────────────────────────

const PlanContext = createContext<PlanContextType | undefined>(undefined);

export const usePlan = (): PlanContextType => {
  const ctx = useContext(PlanContext);
  if (!ctx) throw new Error('usePlan must be used within PlanProvider');
  return ctx;
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function daysLeft(end: Date): number {
  const ms = end.getTime() - Date.now();
  return ms > 0 ? Math.ceil(ms / (1000 * 60 * 60 * 24)) : 0;
}

function buildPlanState(raw: {
  plan: string;
  status: string;
  trial_start: string | null;
  trial_end: string | null;
  subscription_car_limit: number | null;
  billing_cycle: string | null;
} | null): PlanState {
  const plan: Plan = (raw?.plan as Plan) ?? 'basic';
  const trialEnd = raw?.trial_end ? new Date(raw.trial_end) : null;
  const trialStart = raw?.trial_start ? new Date(raw.trial_start) : null;
  const now = new Date();

  const isInTrial = !!(trialEnd && trialEnd > now);
  const isTrialExpired = !!(trialEnd && trialEnd <= now);
  const rawStatus = raw?.status ?? 'active';

  let status: SubscriptionStatus;
  if (rawStatus === 'trial') {
    status = isInTrial ? 'trial' : 'trial_expired';
  } else if (rawStatus === 'suspended') {
    status = 'suspended';
  } else if (rawStatus === 'inactive') {
    status = 'inactive';
  } else if (rawStatus === 'archived') {
    status = 'archived';
  } else if (rawStatus === 'deleted') {
    status = 'deleted';
  } else {
    status = 'active';
  }

  const isActive = status === 'trial' || status === 'active';
  const carLimit = raw?.subscription_car_limit ?? 3;
  const billingCycle: BillingCycle =
    raw?.billing_cycle === 'yearly' ? 'yearly' : 'monthly';

  return {
    plan,
    status,
    trialStart,
    trialEnd,
    trialDaysLeft: isInTrial && trialEnd ? daysLeft(trialEnd) : 0,
    isInTrial,
    isTrialExpired,
    isActive,
    carLimit,
    billingCycle,
  };
}

// ─── Provider ─────────────────────────────────────────────────────────────────

export const PlanProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const { companyId, isSuperAdmin } = useAuth();
  // The price book and the feature map come from app_private.platform_settings
  // through get_app_config() (plan 3.9). Until the database answers, these are
  // the values it was seeded with, so a screen never prices from nothing.
  const { priceBook, planFeatures } = useAppConfig();
  const [planState, setPlanState] = useState<PlanState>(buildPlanState(null));
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!companyId) {
      if (isSuperAdmin) {
        setPlanState({
          plan: 'premium',
          status: 'active',
          trialStart: null,
          trialEnd: null,
          trialDaysLeft: 0,
          isInTrial: false,
          isTrialExpired: false,
          isActive: true,
          carLimit: 999,
          billingCycle: 'monthly',
        });
      }
      setLoading(false);
      return;
    }

    const { data } = await supabase
      .from('companies')
      .select('plan, status, trial_start, trial_end, subscription_car_limit, billing_cycle')
      .eq('id', companyId)
      .maybeSingle();

    setPlanState(buildPlanState(data));
    setLoading(false);
  }, [companyId, isSuperAdmin]);

  useEffect(() => {
    setLoading(true);
    load();
  }, [load]);

  const effectivePlan: Plan = planState.isInTrial ? 'premium' : planState.plan;

  const can = (feature: FeatureKey): boolean => {
    if (isSuperAdmin) return true;
    if (planState.status === 'archived' || planState.status === 'deleted') return false;
    if (!planState.isActive && feature !== 'overview') return false;
    return planHasFeature(planFeatures, effectivePlan, feature);
  };

  const minPlanFor = (feature: FeatureKey): Plan => minPlanForFeature(planFeatures, feature);

  const pricing = calcPricing(priceBook, planState.plan, planState.carLimit, planState.billingCycle);

  return (
    <PlanContext.Provider value={{ planState, loading, can, minPlanFor, effectivePlan, pricing, refresh: load }}>
      {children}
    </PlanContext.Provider>
  );
};
