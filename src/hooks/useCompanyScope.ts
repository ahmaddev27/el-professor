/**
 * The company a screen works in, and what it may do there (plan 3.4b).
 *
 * One hook instead of two, because the answer is one question: a company user
 * works in its own company with its role's rights, and a platform account works
 * in the company its context names — reading only, unless that context is a
 * support session.
 *
 * It composes and adds nothing: the company comes from `SuperAdminContext`,
 * which reads it from the database, and the rights come from `AuthContext`,
 * which reads them from the role. The only thing decided here is that a read
 * context cannot write, and the database decides that again on every statement.
 */
import { useAuth, type PageKey } from '../contexts/AuthContext';
import { useSuperAdmin } from '../contexts/SuperAdminContext';
import { scopedCan, scopedWriteRights, type CompanyScope } from '../lib/companyScope';

/** The same questions the screens already ask `useAuth()`. */
export type WriteRight = (createdByOrRecord?: unknown, page?: PageKey) => boolean;

export type CompanyScopeWithRights = CompanyScope & {
  canCreate: boolean;
  canEdit: WriteRight;
  canDelete: WriteRight;
  can: (page: PageKey, action?: 'view' | 'edit') => boolean;
};

export function useCompanyScope(): CompanyScopeWithRights {
  const { can, canCreate, canEdit, canDelete } = useAuth();
  const { companyScope } = useSuperAdmin();
  return {
    ...companyScope,
    ...scopedWriteRights(companyScope, { canCreate, canEdit, canDelete }),
    can: scopedCan(companyScope, can),
  };
}
