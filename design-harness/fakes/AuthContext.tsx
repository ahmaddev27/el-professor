/**
 * Stands in for AuthContext's hook: a signed-in company user of the invented
 * company, an admin or a viewer as the scenario says. Every other export is the
 * real module's.
 */
import { PREVIEW_USER } from '../../src/design-preview/sampleData';
import { HARNESS_COMPANY_ID, HARNESS_USER_ID, scenario } from '../scenario';

export * from '../../src/contexts/AuthContext';

const mayEdit = scenario.role !== 'viewer';
const email = 'katrin.lindner@example.com';

const value = {
  user: { id: HARNESS_USER_ID, email, last_sign_in_at: new Date().toISOString() },
  profile: {
    id: HARNESS_USER_ID,
    user_id: HARNESS_USER_ID,
    company_id: HARNESS_COMPANY_ID,
    full_name: PREVIEW_USER.name,
    email,
    role: scenario.role,
    status: 'active',
    is_super_admin: false,
  },
  profileLoaded: true,
  profileLoadFailed: false,
  userBlockReason: null,
  session: null,
  loading: false,
  companyId: HARNESS_COMPANY_ID,
  companyStatus: 'active',
  companyApprovalStatus: 'approved',
  rejectionReason: null,
  subscriptionStatus: 'active',
  subscriptionExpiresAt: null,
  effectiveSubscriptionStatus: 'active',
  isSubscriptionActive: true,
  refreshSubscription: async () => undefined,
  isSuperAdmin: false,
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
  isViewer: scenario.role === 'viewer',
  permissions: {},
  can: (_page: string, action: 'view' | 'edit' = 'view') => action === 'view' || mayEdit,
  canCreate: mayEdit,
  canEdit: () => mayEdit,
  canDelete: () => mayEdit,
};

export const useAuth = () => value;
