/**
 * Stands in for AuthContext's hook: a signed-in company user of the invented
 * company, an admin or a viewer as the scenario says. Every other export is the
 * real module's.
 *
 * The `view` and `billing` roles are a platform account instead: no company of
 * its own (`companyId` null, as `user_profiles.company_id` is for staff), the
 * super-admin flag set, and — as the real AuthContext answers every platform
 * account — `can()` true. What such an account may do is decided by the scope
 * (fakes/SuperAdminContext.tsx, fakes/useCompanyScope.ts), as in production.
 */
import { PREVIEW_USER } from '../../src/design-preview/sampleData';
import { HARNESS_COMPANY_ID, HARNESS_USER_ID, isPlatformReader, scenario } from '../scenario';

export * from '../../src/contexts/AuthContext';

const mayEdit = scenario.role !== 'viewer';
const email = isPlatformReader ? 'jana.brenner@elprofessor.example' : 'katrin.lindner@example.com';
const companyId = isPlatformReader ? null : HARNESS_COMPANY_ID;
const role = isPlatformReader ? 'viewer' : scenario.role;

const value = {
  user: { id: HARNESS_USER_ID, email, last_sign_in_at: new Date().toISOString() },
  profile: {
    id: HARNESS_USER_ID,
    user_id: HARNESS_USER_ID,
    company_id: companyId,
    full_name: isPlatformReader ? 'Jana Brenner' : PREVIEW_USER.name,
    email,
    role,
    status: 'active',
    is_super_admin: isPlatformReader,
  },
  profileLoaded: true,
  profileLoadFailed: false,
  userBlockReason: null,
  session: null,
  loading: false,
  companyId,
  companyStatus: 'active',
  companyApprovalStatus: 'approved',
  rejectionReason: null,
  subscriptionStatus: 'active',
  subscriptionExpiresAt: null,
  effectiveSubscriptionStatus: 'active',
  isSubscriptionActive: true,
  refreshSubscription: async () => undefined,
  isSuperAdmin: isPlatformReader,
  mustChangePassword: false,
  signIn: async () => ({ error: null }),
  signOut: async () => undefined,
  authNotice: null,
  setAuthNotice: () => undefined,
  clearAuthNotice: () => undefined,
  googleSignInIntent: null,
  refreshProfile: async () => undefined,
  isAdmin: scenario.role === 'admin',
  isCreator: false,
  isViewer: role === 'viewer',
  permissions: {},
  can: (_page: string, action: 'view' | 'edit' = 'view') => isPlatformReader || action === 'view' || mayEdit,
  canCreate: mayEdit,
  canEdit: () => mayEdit,
  canDelete: () => mayEdit,
};

export const useAuth = () => value;
