/**
 * Stands in for PlanContext's hook in the batch-4 harness: a paying premium
 * company, so no trial banner competes with the screen and every gated
 * navigation item shows. The Abonnement scenarios change the subscription in
 * AuthContext's fake, which is where these screens read it.
 */
import { PREVIEW_CAR_LIMIT } from '../../../src/design-preview/sampleData';
import { recordWrite } from './supabase';

export * from '../../../src/contexts/PlanContext';

const value = {
  planState: {
    plan: 'premium',
    status: 'active',
    trialStart: null,
    trialEnd: null,
    trialDaysLeft: 0,
    isInTrial: false,
    isTrialExpired: false,
    isActive: true,
    carLimit: PREVIEW_CAR_LIMIT,
    billingCycle: 'monthly',
  },
  loading: false,
  can: () => true,
  minPlanFor: () => 'basic',
  effectivePlan: 'premium',
  pricing: { monthly: 0, yearly: 0, billed: 0 },
  refresh: async () => {
    recordWrite('plan', 'refresh', null);
  },
};

export const usePlan = () => value;
