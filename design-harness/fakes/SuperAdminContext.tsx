/**
 * Stands in for SuperAdminContext's hook: a company user in its own company,
 * with no platform access and no open context.
 *
 * The `view` and `billing` roles are a platform account with a read-only view
 * context open on the invented company, as `platform_whoami()` would report
 * it. `read_only` holds business.read, so the database answers it the
 * company's rows, the cash ledger included; `billing` holds no business.read,
 * so the seam `platformReadsCompanyData` is false and the ledger is out of
 * scope. (The harness store applies no RLS: it hands both roles the same rows,
 * and only the screen's own guards differ.)
 */
import { PREVIEW_COMPANY } from '../../src/design-preview/sampleData';
import { HARNESS_COMPANY_ID, isPlatformReader, scenario } from '../scenario';

export * from '../../src/contexts/SuperAdminContext';

const companyScope = isPlatformReader
  ? {
      companyId: HARNESS_COMPANY_ID,
      ownCompanyId: null,
      kind: 'view',
      companyName: PREVIEW_COMPANY,
      readOnly: true,
      isPlatformSession: true,
    }
  : {
      companyId: HARNESS_COMPANY_ID,
      ownCompanyId: HARNESS_COMPANY_ID,
      kind: 'own',
      companyName: null,
      readOnly: false,
      isPlatformSession: false,
    };

const capabilities = scenario.role === 'billing'
  ? ['companies.read', 'billing.manage', 'settings.read']
  : ['companies.read', 'business.read', 'audit.read', 'settings.read'];

const platformAccess = isPlatformReader
  ? {
      role: scenario.role === 'billing' ? 'billing' : 'read_only',
      capabilities,
      companyContext: {
        companyId: HARNESS_COMPANY_ID,
        companyName: PREVIEW_COMPANY,
        mode: 'view',
        expiresAt: new Date(Date.now() + 45 * 60_000).toISOString(),
        secondsRemaining: 45 * 60,
        expiresAtMs: Date.now() + 45 * 60_000,
      },
    }
  : null;

const value = {
  activeCompanyId: isPlatformReader ? HARNESS_COMPANY_ID : null,
  activeCompany: isPlatformReader ? { id: HARNESS_COMPANY_ID, name: PREVIEW_COMPANY } : null,
  isViewingAsCompany: isPlatformReader,
  exitCompany: () => undefined,
  openCompany: async () => ({ ok: false }),
  closeCompany: async () => undefined,
  companyContext: platformAccess?.companyContext ?? null,
  companyScope,
  effectiveCompanyId: HARNESS_COMPANY_ID,
  platformAccess,
  platformAccessStatus: isPlatformReader ? 'ready' : 'idle',
  isPlatformStaff: isPlatformReader,
  platformCan: (capability: string) => capabilities.includes(capability) && isPlatformReader,
  platformReadsCompanyData: scenario.role === 'view',
  ownCompanyReadable: true,
  reloadPlatformAccess: () => undefined,
};

export const useSuperAdmin = () => value;
