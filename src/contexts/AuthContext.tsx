import React, { createContext, useContext, useEffect, useState, useRef, useCallback } from 'react';
import { User, Session } from '@supabase/supabase-js';
import { supabase, isSupabaseConfigured } from '../lib/supabase';
import type { TranslationKey } from '../i18n';

const SESSION_TIMEOUT = 20 * 60 * 1000;
const LAST_ACTIVITY_KEY = 'lastActivity';

interface UserProfile {
  id: string;
  user_id: string;
  email: string;
  full_name?: string;
  /**
   * The four names in the `roles` table. This previously read
   * `'admin' | 'creator' | 'viewer'` — `creator` exists nowhere in the schema,
   * and `supervisor` / `editor`, which do, were missing. Everything derived from
   * a `role === 'creator'` test was therefore dead, and the two real middle roles
   * fell through to the viewer branch.
   */
  role: 'admin' | 'supervisor' | 'editor' | 'viewer';
  role_id: string | null;
  company_id: string | null;
  is_super_admin: boolean;
  status: 'active' | 'inactive' | 'pending_invite' | 'suspended' | 'deactivated';
  must_change_password: boolean;
  created_at: string;
  updated_at: string;
}

/**
 * The `page_key` values in `role_permissions`. Sixteen rows per role, and the
 * same keys the RLS predicate `current_role_permits(page, need_edit)` reads —
 * see 20260910120000_enforce_role_permissions_in_rls.sql.
 */
export type PageKey =
  | 'accounting' | 'cars' | 'cash-balance' | 'documents' | 'drivers'
  | 'fixed-costs' | 'income' | 'notes' | 'overview' | 'receipts'
  | 'roles' | 'salaries' | 'settings' | 'statistics' | 'users' | 'werkstatt';

// Reason codes returned when login is blocked
export type BlockReason =
  | 'user_inactive'
  | 'user_suspended'
  | 'user_deactivated'
  | 'company_suspended'
  | 'company_inactive'
  | 'company_deleted'
  | 'company_pending'
  | 'company_rejected';

/**
 * The message each block reason shows, as a translation key.
 *
 * Keys rather than text because this module sits outside any component and
 * cannot call `t()`. Both consumers — AccountBlockedPage and LoginForm — are
 * inside the provider and resolve it themselves.
 *
 * It used to hold German sentences, and LoginForm told them apart from
 * Supabase's own errors by looking for the words "Ihren Administrator",
 * "Support" and "Postfach" in the string. That worked only while the UI was
 * German: in English it matched nothing, so a blocked user was shown the
 * generic error instead of the reason they were blocked.
 */
export const BLOCK_MESSAGE_KEYS: Record<BlockReason, TranslationKey> = {
  user_inactive:        'blocked.msg.userInactive',
  user_suspended:       'blocked.msg.userSuspended',
  user_deactivated:     'blocked.msg.userDeactivated',
  company_suspended:    'blocked.msg.companySuspended',
  company_inactive:     'blocked.msg.companyInactive',
  company_deleted:      'blocked.msg.companyDeleted',
  company_pending:      'blocked.msg.companyPending',
  company_rejected:     'blocked.msg.companyRejected',
};

/**
 * Maps a user_profiles.status onto a BlockReason, or null when the status
 * permits access. Shared by the sign-in path and the session-restore path so
 * the two cannot drift apart.
 */
export const userStatusBlockReason = (
  status: string | null | undefined,
  isSuperAdmin: boolean,
): BlockReason | null => {
  if (isSuperAdmin) return null; // super admins are never blocked
  if (status === 'inactive') return 'user_inactive';
  if (status === 'suspended') return 'user_suspended';
  if (status === 'deactivated') return 'user_deactivated';
  return null;
};

interface AuthContextType {
  user: User | null;
  profile: UserProfile | null;
  /**
   * Set when the *restored* session belongs to an account that has since been
   * revoked. Sign-in blocks are returned by signIn(); this covers reloads,
   * where signIn() is never called.
   */
  userBlockReason: BlockReason | null;
  session: Session | null;
  loading: boolean;
  companyId: string | null;
  companyApprovalStatus: 'pending' | 'approved' | 'rejected' | 'suspended' | null;
  rejectionReason: string | null;
  subscriptionStatus: 'inactive' | 'active' | 'expired' | 'suspended' | null;
  subscriptionExpiresAt: string | null;
  effectiveSubscriptionStatus: 'inactive' | 'active' | 'expired' | 'suspended' | null;
  isSubscriptionActive: boolean;
  refreshSubscription: () => Promise<void>;
  isSuperAdmin: boolean;
  mustChangePassword: boolean;
  signIn: (email: string, password: string) => Promise<{ error: any; blockReason?: BlockReason }>;
  signOut: () => Promise<void>;
  isAdmin: boolean;
  isCreator: boolean;
  isViewer: boolean;
  /**
   * The caller's row of the `role_permissions` matrix, keyed by page. Empty
   * until the profile loads. This is the same matrix the database now enforces
   * through `current_role_permits()`, so the UI and RLS agree by construction.
   */
  permissions: Record<string, { canView: boolean; canEdit: boolean }>;
  /** Does this role permit `action` on `page`? Super admins always pass. */
  can: (page: PageKey, action?: 'view' | 'edit') => boolean;
  canCreate: boolean;
  /**
   * `page` is what actually decides. The first argument is kept only so the
   * existing call sites still compile — record ownership never worked here: 40
   * of the 50 call sites pass the whole record rather than its `created_by`,
   * and `profile.id` is a bigint compared against a text column, so the
   * comparison was false for every non-admin regardless.
   */
  canEdit: (createdByOrRecord?: unknown, page?: PageKey) => boolean;
  canDelete: (createdByOrRecord?: unknown, page?: PageKey) => boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [companyApprovalStatus, setCompanyApprovalStatus] = useState<'pending' | 'approved' | 'rejected' | 'suspended' | null>(null);
  const [rejectionReason, setRejectionReason] = useState<string | null>(null);
  const [subscriptionStatus, setSubscriptionStatus] = useState<'inactive' | 'active' | 'expired' | 'suspended' | null>(null);
  const [subscriptionExpiresAt, setSubscriptionExpiresAt] = useState<string | null>(null);
  const [userBlockReason, setUserBlockReason] = useState<BlockReason | null>(null);
  const [permissions, setPermissions] = useState<Record<string, { canView: boolean; canEdit: boolean }>>({});

  const sessionTimerRef = useRef<NodeJS.Timeout | null>(null);
  const userRef = useRef<User | null>(null);
  userRef.current = user;

  const isSessionExpired = (session: { user: { last_sign_in_at?: string | null } }) => {
    // A session created moments ago — by a password-reset or invite link, or a
    // sign-in in another tab — is not a stale one. Without this, anyone who had
    // not used the app for 20 minutes (everyone who forgot a password, every
    // newly invited employee) was signed out the instant their link signed them
    // in, and saw "Link ungültig".
    const FRESH_SIGN_IN_MS = 5 * 60 * 1000;
    const signedInAt = session.user.last_sign_in_at ? Date.parse(session.user.last_sign_in_at) : NaN;
    if (Number.isFinite(signedInAt) && Date.now() - signedInAt < FRESH_SIGN_IN_MS) return false;

    const lastActivity = localStorage.getItem(LAST_ACTIVITY_KEY);
    if (!lastActivity) return true;
    return Date.now() - parseInt(lastActivity) > SESSION_TIMEOUT;
  };

  const updateLastActivity = () => {
    localStorage.setItem(LAST_ACTIVITY_KEY, Date.now().toString());
  };

  const clearSessionData = () => {
    localStorage.removeItem(LAST_ACTIVITY_KEY);
    setUser(null);
    setSession(null);
    setProfile(null);
    setCompanyApprovalStatus(null);
    setRejectionReason(null);
    setSubscriptionStatus(null);
    setSubscriptionExpiresAt(null);
    setUserBlockReason(null);
    setPermissions({});
  };

  const signOutRef = useRef<() => Promise<void>>();

  const autoLogout = useCallback(() => {
    if (sessionTimerRef.current) {
      clearTimeout(sessionTimerRef.current);
      sessionTimerRef.current = null;
    }
    signOutRef.current?.();
  }, []);

  const setupSessionTimer = useCallback(() => {
    if (sessionTimerRef.current) clearTimeout(sessionTimerRef.current);
    sessionTimerRef.current = setTimeout(autoLogout, SESSION_TIMEOUT);
  }, [autoLogout]);

  const handleUserActivity = useCallback(() => {
    if (userRef.current) {
      updateLastActivity();
      setupSessionTimer();
    }
  }, [setupSessionTimer]);

  const loadUserProfile = async (userId: string) => {
    try {
      const { data, error } = await supabase
        .from('user_profiles')
        .select('id, user_id, email, full_name, role, role_id, company_id, is_super_admin, status, must_change_password, created_at, updated_at')
        .eq('user_id', userId)
        .maybeSingle();

      if (error && error.code !== 'PGRST116') {
        console.error('Error loading profile:', error);
        return;
      }

      setProfile(data ?? null);

      // Account revocation must bite on every session, not only at sign-in.
      // signIn() calls checkProfileAccess, but a restored session never reaches
      // it, so without this a suspended or deactivated user kept working across
      // reloads indefinitely.
      setUserBlockReason(
        userStatusBlockReason(data?.status, data?.is_super_admin ?? false),
      );

      // Load this role's page matrix. The database enforces the same rows via
      // current_role_permits(), so a screen that hides a button here is a screen
      // whose write RLS would have refused anyway — the UI and the boundary
      // cannot drift.
      //
      // Resolved by role_id. Every profile now carries one; the migration that
      // introduced the RLS predicate backfilled the twelve that did not.
      if (data?.role_id) {
        const { data: perms } = await supabase
          .from('role_permissions')
          .select('page_key, can_view, can_edit')
          .eq('role_id', data.role_id);
        setPermissions(
          Object.fromEntries(
            (perms ?? []).map(p => [p.page_key, { canView: !!p.can_view, canEdit: !!p.can_edit }]),
          ),
        );
      } else {
        setPermissions({});
      }

      // Fetch company approval + subscription status if the user has a company
      if (data?.company_id && !data.is_super_admin) {
        const { data: company } = await supabase
          .from('companies')
          .select('approval_status, rejection_reason, subscription_status, subscription_expires_at')
          .eq('id', data.company_id)
          .maybeSingle();
        if (company) {
          setCompanyApprovalStatus(company.approval_status as 'pending' | 'approved' | 'rejected' | 'suspended');
          setRejectionReason(company.rejection_reason ?? null);
          setSubscriptionStatus(company.subscription_status as 'inactive' | 'active' | 'expired' | 'suspended');
          setSubscriptionExpiresAt(company.subscription_expires_at ?? null);
        }
      } else {
        setCompanyApprovalStatus(null);
        setRejectionReason(null);
        setSubscriptionStatus(null);
        setSubscriptionExpiresAt(null);
      }
    } catch (error) {
      console.error('Profile loading exception:', error);
    }
  };

  // Check if a profile+company is allowed to access the app.
  // Returns a BlockReason if blocked, or null if OK.
  const checkProfileAccess = async (userId: string): Promise<BlockReason | null> => {
    try {
      const { data: profileData } = await supabase
        .from('user_profiles')
        .select('status, company_id, is_super_admin')
        .eq('user_id', userId)
        .maybeSingle();

      if (!profileData) return null; // no profile yet = new user, allow through

      const statusBlock = userStatusBlockReason(
        profileData.status as string,
        !!profileData.is_super_admin,
      );
      if (statusBlock) return statusBlock;
      if (profileData.is_super_admin) return null; // super admins are never blocked

      // Check company status
      if (profileData.company_id) {
        const { data: company } = await supabase
          .from('companies')
          .select('status, approval_status')
          .eq('id', profileData.company_id)
          .maybeSingle();

        if (company) {
          const cs = company.status as string;
          if (cs === 'suspended') return 'company_suspended';
          if (cs === 'inactive') return 'company_inactive';
          if (cs === 'deleted' || cs === 'archived') return 'company_deleted';

          const ap = company.approval_status as string | undefined;
          if (ap === 'pending') return 'company_pending';
          if (ap === 'rejected') return 'company_rejected';
        }
      }
    } catch {
      // On error, allow through (fail open for auth checks)
    }
    return null;
  };

  useEffect(() => {
    const initAuth = async () => {
      if (!isSupabaseConfigured) {
        setLoading(false);
        return;
      }

      try {
        const { data: { session: existingSession }, error } = await supabase.auth.getSession();

        if (error) {
          setLoading(false);
          return;
        }

        if (existingSession) {
          if (isSessionExpired(existingSession)) {
            await supabase.auth.signOut();
            clearSessionData();
            setLoading(false);
          } else {
            updateLastActivity();
            setSession(existingSession);
            setUser(existingSession.user);
            setupSessionTimer();
            await loadUserProfile(existingSession.user.id);
            setLoading(false);
          }
        } else {
          setLoading(false);
        }
      } catch (err) {
        console.error('Session check error:', err);
        setLoading(false);
      }

      const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
        (async () => {
          if (session?.user) {
            updateLastActivity();
            setupSessionTimer();
            setSession(session);
            setUser(session.user);
            await loadUserProfile(session.user.id);
          } else {
            clearSessionData();
            if (sessionTimerRef.current) {
              clearTimeout(sessionTimerRef.current);
              sessionTimerRef.current = null;
            }
          }
        })();
      });

      return subscription;
    };

    let subscription: any;
    initAuth().then(sub => { subscription = sub; });

    return () => {
      if (subscription) subscription.unsubscribe();
      if (sessionTimerRef.current) clearTimeout(sessionTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!user) return;
    const events = ['mousedown', 'keypress', 'touchstart', 'click'];
    events.forEach(event => document.addEventListener(event, handleUserActivity, true));
    return () => {
      events.forEach(event => document.removeEventListener(event, handleUserActivity, true));
    };
  }, [user, handleUserActivity]);

  const signIn = async (email: string, password: string): Promise<{ error: any; blockReason?: BlockReason }> => {
    if (!isSupabaseConfigured) {
      return { error: { message: 'Supabase is not configured' } };
    }
    try {
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) return { error };

      // After successful Supabase auth, check profile/company status
      if (data.user) {
        const blockReason = await checkProfileAccess(data.user.id);
        if (blockReason) {
          // Force sign out — user should not access the app
          await supabase.auth.signOut();
          clearSessionData();
          // `blockReason` is the channel a caller should read — it survives
          // translation. `message` carries the key rather than a sentence so
          // that anything reading only `message` still has something it can
          // resolve, instead of German text in an English UI.
          return { error: { message: BLOCK_MESSAGE_KEYS[blockReason] }, blockReason };
        }
      }

      return { error: null };
    } catch (error) {
      return { error: { message: error instanceof Error ? error.message : 'Sign in failed' } };
    }
  };

  const signOut = async () => {
    if (sessionTimerRef.current) {
      clearTimeout(sessionTimerRef.current);
      sessionTimerRef.current = null;
    }

    if (!isSupabaseConfigured) {
      clearSessionData();
      return;
    }

    try {
      await supabase.auth.signOut();
    } catch (error) {
      console.error('Sign out exception:', error);
      clearSessionData();
    }
  };

  signOutRef.current = signOut;

  const companyId = profile?.company_id ?? null;
  const isSuperAdmin = profile?.is_super_admin ?? false;
  const mustChangePassword = profile?.must_change_password ?? false;
  const isAdmin = profile?.role === 'admin';

  /**
   * Does this role permit `action` on `page`?
   *
   * The matrix is the authority; `isAdmin` is only the fallback for the window
   * before it loads, and for a profile whose role resolves to no rows. Super
   * admins pass unconditionally, matching `current_role_permits()` in the
   * database.
   */
  const can = (page: PageKey, action: 'view' | 'edit' = 'edit'): boolean => {
    if (isSuperAdmin) return true;
    const entry = permissions[page];
    if (!entry) return isAdmin;
    return action === 'view' ? entry.canView : entry.canEdit;
  };

  // Kept for the public shape. `isCreator` used to test role === 'creator',
  // a value the schema has never held; neither export is read anywhere in src/.
  const isCreator = isAdmin;
  const isViewer = profile?.role === 'viewer';

  // Creating a record is an edit. Without a page to ask about, the honest
  // answer is "does this role edit anything at all".
  const canCreate = isSuperAdmin || isAdmin ||
    Object.values(permissions).some(p => p.canEdit);

  // Subscription is active when status=active AND expiry is in the future (or null = no expiry set = legacy active)
  const isSubscriptionActive =
    subscriptionStatus === 'active' &&
    (subscriptionExpiresAt === null || new Date(subscriptionExpiresAt) > new Date());

  // Effective status: if DB says 'active' but expiry is in the past, treat as 'expired'
  const effectiveSubscriptionStatus: 'inactive' | 'active' | 'expired' | 'suspended' | null =
    subscriptionStatus === null ? null :
    subscriptionStatus === 'suspended' ? 'suspended' :
    subscriptionStatus === 'active' && subscriptionExpiresAt !== null && new Date(subscriptionExpiresAt) <= new Date() ? 'expired' :
    subscriptionStatus;

  const refreshSubscription = async () => {
    if (!profile?.company_id) return;
    try {
      const { data: company } = await supabase
        .from('companies')
        .select('subscription_status, subscription_expires_at, approval_status, rejection_reason')
        .eq('id', profile.company_id)
        .maybeSingle();
      if (company) {
        setSubscriptionStatus(company.subscription_status as 'inactive' | 'active' | 'expired' | 'suspended');
        setSubscriptionExpiresAt(company.subscription_expires_at ?? null);
        setCompanyApprovalStatus(company.approval_status as 'pending' | 'approved' | 'rejected' | 'suspended');
        setRejectionReason(company.rejection_reason ?? null);
      }
    } catch {
      // fail silently
    }
  };

  /**
   * Pass the page to get a real answer. Callers that pass a record (or nothing)
   * fall back to `isAdmin`, which is exactly what they already did: the old body
   * compared `profile.id` — a bigint — against `String(createdBy)`, and 40 of the
   * 50 call sites hand it the whole record, so `String()` produced
   * "[object Object]". It was false for every non-admin, always. Preserving that
   * fallback keeps those screens behaving as they do today until each is given
   * its page key.
   */
  const canEdit = (_createdByOrRecord?: unknown, page?: PageKey) =>
    page ? can(page, 'edit') : (isSuperAdmin || isAdmin);

  const canDelete = (_createdByOrRecord?: unknown, page?: PageKey) =>
    page ? can(page, 'edit') : (isSuperAdmin || isAdmin);

  const value = {
    user,
    profile,
    userBlockReason,
    session,
    loading,
    companyId,
    companyApprovalStatus,
    rejectionReason,
    subscriptionStatus,
    subscriptionExpiresAt,
    effectiveSubscriptionStatus,
    isSubscriptionActive,
    refreshSubscription,
    isSuperAdmin,
    mustChangePassword,
    signIn,
    signOut,
    isAdmin,
    isCreator,
    isViewer,
    permissions,
    can,
    canCreate,
    canEdit,
    canDelete,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};
