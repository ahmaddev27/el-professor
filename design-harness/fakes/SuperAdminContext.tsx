/**
 * Stands in for SuperAdminContext's hook: a company user in its own company,
 * with no platform access and no open context.
 */
import { HARNESS_COMPANY_ID } from '../scenario';

export * from '../../src/contexts/SuperAdminContext';

const companyScope = {
  companyId: HARNESS_COMPANY_ID,
  ownCompanyId: HARNESS_COMPANY_ID,
  kind: 'own',
  companyName: null,
  readOnly: false,
  isPlatformSession: false,
};

const value = {
  activeCompanyId: null,
  activeCompany: null,
  isViewingAsCompany: false,
  exitCompany: () => undefined,
  openCompany: async () => ({ ok: false }),
  closeCompany: async () => undefined,
  companyContext: null,
  companyScope,
  effectiveCompanyId: HARNESS_COMPANY_ID,
  platformAccess: null,
  platformAccessStatus: 'idle',
  isPlatformStaff: false,
  platformCan: () => false,
  platformReadsCompanyData: false,
  ownCompanyReadable: true,
  reloadPlatformAccess: () => undefined,
};

export const useSuperAdmin = () => value;
