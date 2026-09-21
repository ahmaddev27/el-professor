/**
 * Stands in for SuperAdminContext's hook in the batch-4 harness.
 *
 * `scope=own` is a company user in its own company. `view` and `support` are a
 * platform account with a company open, in the two modes the database knows:
 * the screens read `companyScope` exactly as they do in production, and the
 * real SupportSessionBar reads `platformAccess.companyContext`, so the bar that
 * tells a support agent whose data this is renders too.
 */
import { HARNESS_COMPANY_ID, scenario } from '../scenario';
import { PREVIEW_COMPANY } from '../../../src/design-preview/sampleData';

export * from '../../../src/contexts/SuperAdminContext';

const platform = scenario.scope !== 'own';
// A context the clock cannot outrun during a capture: 45 minutes from load.
const expiresAtMs = Date.now() + 45 * 60 * 1000;

const companyScope = {
  companyId: HARNESS_COMPANY_ID,
  ownCompanyId: platform ? null : HARNESS_COMPANY_ID,
  kind: scenario.scope,
  companyName: platform ? PREVIEW_COMPANY : null,
  readOnly: scenario.scope === 'view',
  isPlatformSession: platform,
};

const companyContext = platform
  ? {
      companyId: HARNESS_COMPANY_ID,
      companyName: PREVIEW_COMPANY,
      mode: scenario.scope,
      expiresAt: new Date(expiresAtMs).toISOString(),
      secondsRemaining: 45 * 60,
      expiresAtMs,
    }
  : null;

const platformAccess = platform
  ? { role: 'owner', capabilities: ['business.read', 'support.session', 'companies.read'], companyContext }
  : null;

const value = {
  activeCompanyId: platform ? HARNESS_COMPANY_ID : null,
  activeCompany: platform ? { id: HARNESS_COMPANY_ID, name: PREVIEW_COMPANY } : null,
  isViewingAsCompany: platform,
  exitCompany: () => undefined,
  openCompany: async () => ({ ok: false }),
  closeCompany: async () => undefined,
  companyContext,
  companyScope,
  effectiveCompanyId: HARNESS_COMPANY_ID,
  platformAccess,
  platformAccessStatus: platform ? 'ready' : 'idle',
  isPlatformStaff: platform,
  platformCan: (capability: string) => platformAccess?.capabilities.includes(capability) ?? false,
  platformReadsCompanyData: platform,
  ownCompanyReadable: !platform,
  reloadPlatformAccess: () => undefined,
};

export const useSuperAdmin = () => value;
