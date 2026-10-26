/**
 * Stands in for PlanContext's hook in the batch-4 harness: a paying premium
 * company, so no trial banner competes with the screen and every gated
 * navigation item shows. The Abonnement scenarios change the subscription in
 * AuthContext's fake, which is where these screens read it.
 */
import { NO_MODULE_DECISIONS } from '../../../src/lib/companyModules';
import { PREVIEW_CAR_LIMIT } from '../../../src/design-preview/sampleData';
import { recordWrite } from './supabase';

export * from '../../../src/contexts/PlanContext';

const value = {
  planState: {
    plan: 'premium',
    status: 'active',
    isActive: true,
    carLimit: PREVIEW_CAR_LIMIT,
    billingCycle: 'monthly',
  },
  loading: false,
  can: () => true,
  minPlanFor: () => 'basic',
  effectivePlan: 'premium',
  pricing: { monthly: 0, yearly: 0, billed: 0 },
  /*
    No module decisions — every sidebar module on, which is what absence of a
    row means (`src/lib/companyModules.ts`). Added because `c775901` gave
    `usePlan()` this field and `Sidebar.renderNavItem` now reads it through
    `moduleEnabledForRoute(companyModules, …)`: without it the whole harness
    died on `Cannot read properties of undefined (reading 'overview')` inside
    `SidebarContent`, so every batch-4 shot came out as an error page. The break
    was on `staging`, not in this branch's own change.
  */
  companyModules: NO_MODULE_DECISIONS,
  refresh: async () => {
    recordWrite('plan', 'refresh', null);
  },
};

export const usePlan = () => value;
