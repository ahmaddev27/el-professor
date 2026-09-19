import React, { createContext, useContext, useEffect, useState, useCallback, ReactNode } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from './AuthContext';
import { useSuperAdmin } from './SuperAdminContext';
import { useAppConfig } from './AppConfigContext';
import { calcPricing, PriceBreakdown, BillingCycle } from '../utils/pricing';
import { minPlanForFeature } from '../utils/planFeatures';
import { buildPlanState, effectivePlanOf, planAllows } from '../utils/planState';

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

// ─── Provider ─────────────────────────────────────────────────────────────────

export const PlanProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const { isSuperAdmin } = useAuth();
  /*
    The company the session is in (plan 3.4b). Inside a support session the
    plan on screen must be the customer's own, or the staff member reads the
    fabricated premium below and is told a locked screen is available — or,
    worse, reports a plan to the customer that the customer does not hold.

    What this does *not* change is the gate: `planAllows(..., isSuperAdmin)`
    still answers true for a platform account whatever the plan says, so
    reading the real plan cannot lock a support session out of a screen.
  */
  const { effectiveCompanyId: companyId } = useSuperAdmin();
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

    // The subscription columns are read here, in the same row as `status` and
    // `trial_end`, rather than taken from AuthContext's copy: the state machine
    // in `utils/planState.ts` needs all four to agree, and AuthContext fetches
    // the company only *after* it has set the profile — so `companyId` arrives
    // one round trip before the subscription does, and a plan state built from
    // the two contexts would spend that window calling a paying customer
    // unsubscribed. The rule itself is not copied: `subscriptionIsActive()` is
    // the one place it is written, and AuthContext asks the same function.
    const { data } = await supabase
      .from('companies')
      // One literal, not a concatenation: supabase-js parses the column list at
      // the type level, and a `+` leaves it with `GenericStringError`.
      .select('plan, status, trial_start, trial_end, subscription_status, subscription_expires_at, subscription_car_limit, billing_cycle')
      .eq('id', companyId)
      .maybeSingle();

    setPlanState(buildPlanState(data));
    setLoading(false);
  }, [companyId, isSuperAdmin]);

  useEffect(() => {
    setLoading(true);
    load();
  }, [load]);

  const effectivePlan: Plan = effectivePlanOf(planState);

  const can = (feature: FeatureKey): boolean =>
    planAllows(planState, planFeatures, feature, isSuperAdmin);

  const minPlanFor = (feature: FeatureKey): Plan => minPlanForFeature(planFeatures, feature);

  const pricing = calcPricing(priceBook, planState.plan, planState.carLimit, planState.billingCycle);

  return (
    <PlanContext.Provider value={{ planState, loading, can, minPlanFor, effectivePlan, pricing, refresh: load }}>
      {children}
    </PlanContext.Provider>
  );
};
