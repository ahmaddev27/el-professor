/**
 * The address locator for the Fahrtenanalyse, or null while it is off.
 *
 * Reads the switch (the `travel_estimator` flag), the company the screen shows and
 * the account's own rights, asks locatorPlan what that comes to, and builds the
 * locator for it once. The page hands the result to useTravelEstimator; null means
 * nothing is asked of anybody.
 */
import { useMemo } from 'react';
import { useFlag } from '../contexts/AppConfigContext';
import { useAuth } from '../contexts/AuthContext';
import { useSuperAdmin } from '../contexts/SuperAdminContext';
import { createAppAddressLocator } from '../lib/addressLocator';
import { TRAVEL_ESTIMATOR_FLAG, locatorPlan } from '../utils/travelRouting/locatorPlan';
import type { AddressLocator } from '../utils/travelRouting/prefetch';

export function useAppAddressLocator(): AddressLocator | null {
  const { companyId: membershipCompanyId, isAdmin } = useAuth();
  const { effectiveCompanyId } = useSuperAdmin();
  const flagOn = useFlag(TRAVEL_ESTIMATOR_FLAG);
  const plan = locatorPlan({ flagOn, effectiveCompanyId, membershipCompanyId, isAdmin });
  const companyId = plan.enabled ? plan.companyId : null;
  const canWrite = plan.enabled && plan.canWrite;
  return useMemo(() => (companyId === null ? null : createAppAddressLocator({ companyId, canWrite })), [companyId, canWrite]);
}
