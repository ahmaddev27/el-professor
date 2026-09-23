/**
 * Stands in for useCompanyScope: the user's own company, with the rights of the
 * scenario's role. For the `view` and `billing` roles the company comes from a
 * read-only view context, where nothing may be written (scopedCan in
 * src/lib/companyScope.ts answers `edit` false there).
 */
import { HARNESS_COMPANY_ID, isPlatformReader, scenario } from '../scenario';

export * from '../../src/hooks/useCompanyScope';

const mayEdit = scenario.role !== 'viewer' && !isPlatformReader;

const value = {
  companyId: HARNESS_COMPANY_ID,
  readOnly: isPlatformReader,
  canCreate: mayEdit,
  canEdit: () => mayEdit,
  canDelete: () => mayEdit,
  can: (_page: string, action: 'view' | 'edit' = 'view') => action === 'view' || mayEdit,
};

export function useCompanyScope() {
  return value;
}
