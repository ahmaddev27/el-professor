import React, { createContext, useContext, useEffect, useState, useRef, useCallback } from 'react';
import { User, Session } from '@supabase/supabase-js';
import { supabase, isSupabaseConfigured, appOrigin } from '../lib/supabase';

const SESSION_TIMEOUT = 20 * 60 * 1000;
const LAST_ACTIVITY_KEY = 'lastActivity';

interface UserProfile {
  id: string;
  user_id: string;
  email: string;
  full_name?: string;
  role: 'admin' | 'creator' | 'viewer';
  role_id: string | null;
  company_id: string | null;
  is_super_admin: boolean;
  status: 'active' | 'inactive' | 'pending_invite' | 'suspended' | 'deactivated';
  must_change_password: boolean;
  created_at: string;
  updated_at: string;
}

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

export const BLOCK_MESSAGES: Record<BlockReason, string> = {
  user_inactive:        'Ihr Benutzerkonto ist deaktiviert. Bitte kontaktieren Sie Ihren Administrator.',
  user_suspended:       'Ihr Benutzerkonto ist gesperrt. Bitte kontaktieren Sie Ihren Administrator.',
  user_deactivated:     'Ihr Benutzerkonto wurde deaktiviert. Bitte kontaktieren Sie Ihren Administrator.',
  company_suspended:    'Ihr Unternehmenskonto ist gesperrt. Bitte kontaktieren Sie den Support.',
  company_inactive:     'Ihr Unternehmenskonto ist nicht mehr aktiv. Bitte kontaktieren Sie den Support.',
  company_deleted:      'Ihr Unternehmenskonto wurde gelöscht. Bitte kontaktieren Sie den Support.',
  company_pending:      'Ihre Registrierung wird geprüft. Bitte warten Sie auf die Freischaltung durch unser Team.',
  company_rejected:     'Ihre Registrierung wurde abgelehnt. Bitte kontaktieren Sie den Support.',
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
   * revoked. Sign-in blocks are returned by signIn(); this covers the reload and
   * OAuth paths, where signIn() is never called.
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
  signUp: (email: string, password: string, fullName?: string) => Promise<{ error: any }>;
  signInWithGoogle: () => Promise<{ error: any }>;
  signOut: () => Promise<void>;
  isAdmin: boolean;
  isCreator: boolean;
  isViewer: boolean;
  canCreate: boolean;
  canEdit: (createdBy?: string) => boolean;
  canDelete: (createdBy?: string) => boolean;
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

  const sessionTimerRef = useRef<NodeJS.Timeout | null>(null);
  const userRef = useRef<User | null>(null);
  userRef.current = user;

  const isSessionExpired = () => {
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
      // signIn() calls checkProfileAccess, but a restored session and the Google
      // OAuth path never reach it, so a suspended or deactivated user kept working
      // across reloads indefinitely.
      setUserBlockReason(
        userStatusBlockReason(data?.status, data?.is_super_admin ?? false),
      );

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
          if (isSessionExpired()) {
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
          return { error: { message: BLOCK_MESSAGES[blockReason] }, blockReason };
        }
      }

      return { error: null };
    } catch (error) {
      return { error: { message: error instanceof Error ? error.message : 'Sign in failed' } };
    }
  };

  const signUp = async (email: string, password: string, fullName?: string) => {
    if (!isSupabaseConfigured) {
      return { error: { message: 'Supabase is not configured' } };
    }
    try {
      const { error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          data: { full_name: fullName || '' },
          emailRedirectTo: `${appOrigin}/auth/callback`,
        },
      });
      return { error };
    } catch (error) {
      return { error: { message: error instanceof Error ? error.message : 'Sign up failed' } };
    }
  };

  const signInWithGoogle = async (): Promise<{ error: any }> => {
    if (!isSupabaseConfigured) {
      return { error: { message: 'Supabase is not configured' } };
    }
    try {
      const { error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: `${appOrigin}/auth/callback`,
          queryParams: {
            access_type: 'offline',
            prompt: 'consent',
          },
        },
      });
      return { error };
    } catch (error) {
      return { error: { message: error instanceof Error ? error.message : 'Google sign in failed' } };
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
  const isCreator = profile?.role === 'creator' || isAdmin;
  const isViewer = profile?.role === 'viewer' && !isAdmin && !isCreator;
  const canCreate = isAdmin || isCreator;

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

  const canEdit = (createdBy?: string | number) => {
    if (isAdmin) return true;
    if (!createdBy) return false;
    return profile?.id === String(createdBy);
  };

  const canDelete = (createdBy?: string | number) => {
    if (isAdmin) return true;
    if (!createdBy) return false;
    return profile?.id === String(createdBy);
  };

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
    signUp,
    signInWithGoogle,
    signOut,
    isAdmin,
    isCreator,
    isViewer,
    canCreate,
    canEdit,
    canDelete,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};
