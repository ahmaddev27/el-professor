/**
 * Stands in for AuthContext's hook in the batch-4 harness. Every other export —
 * BLOCK_MESSAGE_KEYS above all, which LoginForm and AccountBlockedPage read —
 * is the real module's.
 *
 * Who is signed in depends on the screen: nobody on the signed-out screens, a
 * Google account without a company on the registration screen, the company's
 * admin (or a viewer) everywhere else. `signIn` answers what the scenario's
 * `signin` names, in the shapes the real one returns: our own block reason with
 * its key, or GoTrue's error as supabase-js carries it.
 */
import { useState } from 'react';
import { PREVIEW_USER } from '../../../src/design-preview/sampleData';
import type { BlockReason } from '../../../src/contexts/AuthContext';
import { recordWrite } from './supabase';
import { HARNESS_COMPANY_ID, HARNESS_EMAIL, HARNESS_USER_ID, scenario } from '../scenario';

export * from '../../../src/contexts/AuthContext';

const SIGNED_OUT = new Set(['login', 'forgot', 'verify-email', 'signup', 'callback']);
const signedIn = !SIGNED_OUT.has(scenario.screen) && !(scenario.screen === 'invite' && scenario.session !== 'other');
const googleAccountWithoutCompany = scenario.screen === 'complete-registration';
const mayEdit = scenario.role !== 'viewer';

const email = scenario.screen === 'invite' ? 'andere.person@example.com' : HARNESS_EMAIL;

/** Mirrors the error objects supabase-js hands AuthContext.signIn, one per LoginForm branch. */
function signInAnswer(): { error: { message: string; code?: string } | null; blockReason?: BlockReason } {
  switch (scenario.signIn) {
    case 'blocked':
      return { error: { message: 'blocked.msg.userDeactivated' }, blockReason: 'user_deactivated' };
    case 'unconfirmed':
      return { error: { message: 'Email not confirmed', code: 'email_not_confirmed' } };
    case 'too-many':
      return { error: { message: 'Request rate limit reached', code: 'over_request_rate_limit' } };
    case 'network':
      return { error: { message: 'TypeError: Failed to fetch' } };
    case 'generic':
      return { error: { message: 'Database error querying schema', code: 'unexpected_failure' } };
    default:
      return { error: { message: 'Invalid login credentials', code: 'invalid_credentials' } };
  }
}

const subscription =
  scenario.data === 'expired'
    ? { status: 'expired', expiresAt: '2026-09-01T00:00:00+02:00', active: false }
    : scenario.data === 'inactive' || scenario.data === 'history'
      ? { status: 'inactive', expiresAt: null, active: false }
      : { status: 'active', expiresAt: '2026-10-01T10:00:00+02:00', active: true };

const user = signedIn
  ? {
      id: HARNESS_USER_ID,
      email,
      last_sign_in_at: new Date().toISOString(),
      user_metadata: googleAccountWithoutCompany ? { full_name: PREVIEW_USER.name } : {},
      app_metadata: { provider: googleAccountWithoutCompany ? 'google' : 'email' },
    }
  : null;

const profile = signedIn && !googleAccountWithoutCompany
  ? {
      id: HARNESS_USER_ID,
      user_id: HARNESS_USER_ID,
      company_id: HARNESS_COMPANY_ID,
      full_name: PREVIEW_USER.name,
      email,
      role: scenario.role,
      status: 'active',
      is_super_admin: false,
    }
  : null;

export const useAuth = () => {
  // The notice LoginForm shows on mount, then clears — held in state so the
  // clear re-renders exactly as the real context does.
  const [authNotice, setAuthNotice] = useState<string | null>(
    scenario.notice === 'platform-google' ? 'auth.google.error.platformStaff' : null,
  );
  return {
    user,
    profile,
    profileLoaded: true,
    profileLoadFailed: false,
    userBlockReason: null,
    session: signedIn ? { access_token: 'harness-access-token', user } : null,
    loading: false,
    companyId: profile ? HARNESS_COMPANY_ID : null,
    companyStatus: 'active',
    companyApprovalStatus: 'approved',
    rejectionReason: scenario.screen === 'rejected' ? 'Die Konzessionsurkunde fehlt. Bitte reichen Sie sie nach und registrieren Sie sich erneut.' : null,
    subscriptionStatus: subscription.status,
    subscriptionExpiresAt: subscription.expiresAt,
    effectiveSubscriptionStatus: subscription.status,
    isSubscriptionActive: subscription.active,
    refreshSubscription: async () => undefined,
    isSuperAdmin: false,
    mustChangePassword: false,
    signIn: async (typedEmail: string) => {
      recordWrite('auth', 'signIn', { email: typedEmail });
      await new Promise(resolve => setTimeout(resolve, 150));
      return signInAnswer();
    },
    signOut: async () => {
      recordWrite('auth', 'signOut', null);
    },
    authNotice,
    setAuthNotice,
    clearAuthNotice: () => setAuthNotice(null),
    googleSignInIntent: googleAccountWithoutCompany
      ? { from: scenario.intentFromInvite ? 'invite' : 'signup', selection: { plan: 'premium', carLimit: 6, billingCycle: 'yearly' } }
      : null,
    refreshProfile: async () => undefined,
    isAdmin: signedIn && scenario.role === 'admin',
    isCreator: false,
    isViewer: scenario.role === 'viewer',
    permissions: {},
    can: (_page: string, action: 'view' | 'edit' = 'view') => action === 'view' || mayEdit,
    canCreate: mayEdit,
    canEdit: () => mayEdit,
    canDelete: () => mayEdit,
  };
};
