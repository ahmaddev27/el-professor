/**
 * Stands in for PlanContext's hook: a paying premium company, so no trial
 * banner competes with the screen, and every gated navigation item shows.
 *
 * The car limit is the prototype's, except in the `limit` scenario, where it
 * equals the invented fleet so the Fahrzeuge screen shows its limit state.
 */
import { PREVIEW_CAR_LIMIT, PREVIEW_VEHICLES } from '../../src/design-preview/sampleData';
import { scenario } from '../scenario';

export * from '../../src/contexts/PlanContext';

const carLimit = scenario.data === 'limit' ? PREVIEW_VEHICLES.length : PREVIEW_CAR_LIMIT;

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
    carLimit,
    billingCycle: 'monthly',
  },
  loading: false,
  can: () => true,
  minPlanFor: () => 'basic',
  effectivePlan: 'premium',
  pricing: { monthly: 0, yearly: 0, billed: 0 },
  refresh: async () => undefined,
};

export const usePlan = () => value;
