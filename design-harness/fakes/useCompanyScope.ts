/**
 * Stands in for useCompanyScope: the user's own company, with the rights of the
 * scenario's role. No platform context is ever open in the harness.
 */
import { HARNESS_COMPANY_ID, scenario } from '../scenario';

export * from '../../src/hooks/useCompanyScope';

const mayEdit = scenario.role !== 'viewer';

const value = {
  companyId: HARNESS_COMPANY_ID,
  readOnly: false,
  canCreate: mayEdit,
  canEdit: () => mayEdit,
  canDelete: () => mayEdit,
  can: (_page: string, action: 'view' | 'edit' = 'view') => action === 'view' || mayEdit,
};

export function useCompanyScope() {
  return value;
}
