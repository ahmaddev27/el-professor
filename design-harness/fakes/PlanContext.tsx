/**
 * Stands in for PlanContext's hook: a paying premium company, so no trial
 * banner competes with the screen, and every gated navigation item shows.
 *
 * The car limit is the prototype's, except in the `limit` scenario:
 *   - Fahrzeuge: it equals the invented fleet, so the screen shows its limit.
 *   - Fahrer: the driver limit is the car limit times the company's drivers
 *     per car, 4 when company_settings names none (DriversManagement's own
 *     default), so the car limit is set to make it equal the active drivers.
 */
import { PREVIEW_CAR_LIMIT, PREVIEW_VEHICLES } from '../../src/design-preview/sampleData';
import { NO_MODULE_DECISIONS } from '../../src/lib/companyModules';
import { ACTIVE_DRIVER_COUNT } from '../fixtures-batch1b';
import { scenario } from '../scenario';

export * from '../../src/contexts/PlanContext';

const DRIVERS_PER_CAR_DEFAULT = 4;

const carLimit =
  scenario.data !== 'limit'
    ? PREVIEW_CAR_LIMIT
    : scenario.screen === 'fahrer'
      ? ACTIVE_DRIVER_COUNT / DRIVERS_PER_CAR_DEFAULT
      : PREVIEW_VEHICLES.length;

const value = {
  planState: {
    plan: 'premium',
    status: 'active',
    isActive: true,
    carLimit,
    billingCycle: 'monthly',
  },
  loading: false,
  /*
    No stored decision for any module, which is what an untouched company has
    and what `company_modules` reads as every module ON (`src/lib/
    companyModules.ts`). The real `usePlan()` has carried this field since
    slice 1 and **two** harness-rendered things now read it: `Sidebar.
    renderNavItem` through `moduleEnabledForRoute`, and `OverviewPage` through
    `overviewReadEnabled` / `overviewPanelOffModules`. Without it the readers
    get `undefined[key]` and the harness dies on the frame, before any screen
    renders — `design-harness/batch4/fakes/PlanContext.tsx` already carried this
    line for the first of the two and this file was simply missed.
  */
  companyModules: NO_MODULE_DECISIONS,
  can: () => true,
  minPlanFor: () => 'basic',
  effectivePlan: 'premium',
  pricing: { monthly: 0, yearly: 0, billed: 0 },
  refresh: async () => undefined,
};

export const usePlan = () => value;
