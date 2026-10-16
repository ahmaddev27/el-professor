import React, { createContext, useContext, useEffect, useState, useRef, useCallback } from 'react';
import { User, Session } from '@supabase/supabase-js';
import { AUTH_STORAGE_KEY, supabase, isSupabaseConfigured } from '../lib/supabase';
import type { TranslationKey } from '../i18n';
import { consumeGoogleSignInIntent, readGoogleSignInIntent, type GoogleSignInIntent } from '../lib/googleSignIn';
import { googleSessionIsSettled, sessionCameFromGoogle } from '../lib/googleAccount';
import { nextAfterReconcile, reconcileOauthAccount } from '../lib/oauthAccountClient';
import { SIGN_IN_PATH, googleSignInRefusal } from '../lib/adminGate';
import { attemptUntilAnswered } from '../lib/profileLoadRetry';
import { subscriptionIsActive } from '../utils/planState';

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

/**
 * The six values `companies_status_check` allows (20260916130000).
 *
 * Since 20260919150000 this column is the **only** place a suspension is
 * recorded: `approval_status` and `subscription_status` no longer admit
 * `'suspended'`, and their CHECK constraints refuse it.
 */
export type CompanyStatus = 'active' | 'suspended' | 'inactive' | 'archived' | 'deleted';

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
   * Whether the profile query has answered for the session in hand — true also
   * when it answered "no row".
   *
   * `profile === null` cannot tell that apart from "not read yet", and every
   * gate in App.tsx reads the profile: a failed or still-running load looked
   * exactly like an account that has no profile row, which let a company-less
   * account past the registration gate and the approval gates into the tenant
   * router.
   */
  profileLoaded: boolean;
  /**
   * The profile load ran out of attempts without an answer. `profileLoaded`
   * stays false — the gate keeps its meaning — and the screen offers a retry
   * (`refreshProfile`) and a sign-out instead of waiting indefinitely, because
   * nothing else reloads the profile until a token refresh or a page reload.
   */
  profileLoadFailed: boolean;
  /**
   * Set when the *restored* session belongs to an account that has since been
   * revoked. Sign-in blocks are returned by signIn(); this covers reloads and
   * sessions installed from a one-time code, where signIn() is never called.
   */
  userBlockReason: BlockReason | null;
  session: Session | null;
  loading: boolean;
  companyId: string | null;
  /**
   * `companies.status`, and since 20260919150000 the **one** place a suspension
   * is recorded. Read on every load and refresh, not only at sign-in: before
   * that migration a suspension could also sit in `approval_status` or
   * `subscription_status`, and it was one of those two that App.tsx's gate
   * happened to see. `checkProfileAccess()` below reads the same column but
   * runs only on `signIn`.
   */
  companyStatus: CompanyStatus | null;
  companyApprovalStatus: 'pending' | 'approved' | 'rejected' | 'suspended' | null;
  rejectionReason: string | null;
  subscriptionStatus: 'inactive' | 'active' | 'expired' | 'suspended' | null;
  subscriptionExpiresAt: string | null;
  effectiveSubscriptionStatus: 'inactive' | 'active' | 'expired' | 'suspended' | null;
  isSubscriptionActive: boolean;
  refreshSubscription: () => Promise<void>;
  isSuperAdmin: boolean;
  mustChangePassword: boolean;
  /**
   * Password sign-in. The owner of a company still pending approval, or
   * rejected, stays signed in and App shows PendingApprovalPage or RejectedPage.
   * Every other block signs the session straight out again and is returned.
   */
  signIn: (email: string, password: string) => Promise<{ error: any; blockReason?: BlockReason }>;
  signOut: () => Promise<void>;
  /**
   * A sentence for the sign-in screen after a session was ended for a reason of
   * our own: a Google sign-in that must not stand (plan 1.6), or a platform
   * account sent back to sign in with the password it has just chosen
   * (`SetPasswordPage`). Whoever shows it clears it.
   *
   * It is state above `App` and outside `clearSessionData` on purpose, so it
   * outlives both the sign-out and the router swap that follows it. A caller
   * that sets one and then does *not* end the session must clear it again, or
   * it surfaces on the next sign-in screen anyone opens.
   */
  authNotice: TranslationKey | null;
  setAuthNotice: (notice: TranslationKey) => void;
  clearAuthNotice: () => void;
  /** The Google button press this session came from, while it is still relevant. */
  googleSignInIntent: GoogleSignInIntent | null;
  /** Re-reads the caller's own profile, company and subscription. */
  refreshProfile: () => Promise<void>;
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
  // "The profile query has answered", which is not the same as "profile is set".
  const [profileLoaded, setProfileLoaded] = useState(false);
  // Every attempt is used up and none answered: show a way out, not a spinner.
  const [profileLoadFailed, setProfileLoadFailed] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [companyStatus, setCompanyStatus] = useState<CompanyStatus | null>(null);
  const [companyApprovalStatus, setCompanyApprovalStatus] = useState<'pending' | 'approved' | 'rejected' | 'suspended' | null>(null);
  const [rejectionReason, setRejectionReason] = useState<string | null>(null);
  const [subscriptionStatus, setSubscriptionStatus] = useState<'inactive' | 'active' | 'expired' | 'suspended' | null>(null);
  const [subscriptionExpiresAt, setSubscriptionExpiresAt] = useState<string | null>(null);
  const [userBlockReason, setUserBlockReason] = useState<BlockReason | null>(null);
  const [permissions, setPermissions] = useState<Record<string, { canView: boolean; canEdit: boolean }>>({});
  // Outside clearSessionData on purpose: the notice explains a sign-out and has
  // to outlive it.
  const [authNotice, setAuthNotice] = useState<TranslationKey | null>(null);
  const [googleSignInIntent, setGoogleSignInIntent] = useState<GoogleSignInIntent | null>(null);

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
    setProfileLoaded(false);
    setProfileLoadFailed(false);
    setCompanyStatus(null);
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

  /**
   * One attempt. Returns whether the profile query *answered* — with a row or
   * with none — which is what `profileLoaded` means. A step after it that fails
   * (the permission matrix, the company) leaves the profile loaded and is
   * swallowed as before: it is not a reason to fetch the profile again.
   */
  const loadUserProfileOnce = async (userId: string): Promise<boolean> => {
    let answered = false;
    try {
      const { data, error } = await supabase
        .from('user_profiles')
        .select('id, user_id, email, full_name, role, role_id, company_id, is_super_admin, status, must_change_password, created_at, updated_at')
        .eq('user_id', userId)
        .maybeSingle();

      if (error && error.code !== 'PGRST116') {
        console.error('Error loading profile:', error);
        // A failure is not an answer, so `profileLoaded` is left exactly where
        // it was: false on the first load, which holds App on the spinner
        // rather than letting a gate read this as "the account has no profile
        // row"; true on a later refresh, so one failed refresh cannot blank a
        // session that is working.
        return false;
      }

      // The query answered — with a row, or with none. Those are different
      // things from "not read yet", and the gates in App.tsx cannot tell them
      // apart from `profile` alone.
      setProfile(data ?? null);
      setProfileLoaded(true);
      answered = true;

      // Account revocation must bite on every session, not only at sign-in.
      // signIn() calls checkProfileAccess, but a restored session and a session
      // installed from a one-time code never reach it, so without this a
      // suspended or deactivated user kept working across reloads indefinitely.
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
          .select('status, approval_status, rejection_reason, subscription_status, subscription_expires_at')
          .eq('id', data.company_id)
          .maybeSingle();
        if (company) {
          setCompanyStatus(company.status as CompanyStatus);
          setCompanyApprovalStatus(company.approval_status as 'pending' | 'approved' | 'rejected' | 'suspended');
          setRejectionReason(company.rejection_reason ?? null);
          setSubscriptionStatus(company.subscription_status as 'inactive' | 'active' | 'expired' | 'suspended');
          setSubscriptionExpiresAt(company.subscription_expires_at ?? null);
        }
      } else {
        setCompanyStatus(null);
        setCompanyApprovalStatus(null);
        setRejectionReason(null);
        setSubscriptionStatus(null);
        setSubscriptionExpiresAt(null);
      }
    } catch (error) {
      // As above: an exception is not an answer either, so the flag keeps its
      // value and a load that threw before answering is retried below.
      console.error('Profile loading exception:', error);
    }
    return answered;
  };

  /**
   * The profile load every caller uses: a few bounded attempts, and then an
   * admission of failure.
   *
   * Failing closed is the point — `profileLoaded` is still raised only by a
   * query that answered — but a first load that fails would otherwise leave App
   * on a spinner with nothing to press until a token refresh or a page reload.
   * `profileLoadFailed` is what puts the retry and the sign-out on the screen.
   */
  const loadUserProfile = async (userId: string) => {
    setProfileLoadFailed(false);
    const answered = await attemptUntilAnswered(() => loadUserProfileOnce(userId));
    if (!answered) setProfileLoadFailed(true);
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

  // ─── Google sessions (plan step 1.6) ──────────────────────────────────────
  //
  // Every Google sign-in is settled once, by the `oauth-account` function:
  // it cancels a password signup Google has just confirmed, or accepts a
  // pending invitation. The database decides which, and refuses anything else.
  //
  // Two accounts never get that far. A platform account signs in with an email
  // address and a password, never with Google (the owner's decision of
  // 16.09.2026) — the database refuses it in all three actions, and this is the
  // sentence that says so. And an account GoTrue no longer has, or has banned,
  // is signed out rather than left holding a token for nothing.
  //
  // `sessionCameFromGoogle` is what decides, not "the account has a Google
  // identity": a platform account whose address also exists at Google must keep
  // signing in with its password.
  const settledGoogleFor = useRef<string | null>(null);

  useEffect(() => {
    if (loading || !user || !session || !profile) return;
    const intent = readGoogleSignInIntent();
    const cameFromGoogle = sessionCameFromGoogle(user, intent !== null);
    if (!cameFromGoogle) return;
    if (settledGoogleFor.current === user.id) return;
    settledGoogleFor.current = user.id;
    // Kept in memory for the registration screen, and taken out of the store:
    // the press it recorded has been answered.
    if (intent) setGoogleSignInIntent(intent);
    consumeGoogleSignInIntent();

    let cancelled = false;

    // Signing out swaps App's router, and the public one starts wherever the
    // address points — without this the message below would land on the
    // landing page, where nothing shows it. Same reason useOtpSessionHandoff
    // rewrites the address before installing a session. `SIGN_IN_PATH` is the
    // one sign-in screen since the owner's decision of 17.09.2026, so this is
    // also the screen a platform account is sent back to.
    const endSession = async (message: TranslationKey, to: string = SIGN_IN_PATH) => {
      window.history.replaceState(window.history.state, '', to);
      setAuthNotice(message);
      await signOutRef.current?.();
    };

    void (async () => {
      // Platform staff sign in with an address and a password, never with
      // Google. The rule, and why it asks how this *session* was minted rather
      // than whether the account has a Google identity, is in
      // `googleSignInRefusal` — where it is also tested.
      const refusal = googleSignInRefusal({ cameFromGoogle, isPlatformAccount: profile.is_super_admin });
      if (refusal) {
        await endSession(refusal.messageKey, refusal.to);
        return;
      }
      // Nothing left to settle. `reconcile` cancels a password signup or
      // accepts an invitation, and an account that already holds a company and
      // is active has neither pending — the call could only answer
      // `nothing_pending`. Without this, an owner who registered through Google
      // months ago calls the edge function on every page load for the life of
      // the account: `sessionCameFromGoogle` is true for a Google-created
      // account with no marker at all, and the ref above starts empty each load.
      if (googleSessionIsSettled(profile)) return;
      const routing = nextAfterReconcile(await reconcileOauthAccount(session.access_token));
      if (cancelled) return;
      // The database changed the profile: the gates must not read the old one.
      if (routing.reloadProfile) await loadUserProfile(user.id);
      if (cancelled) return;
      if (routing.route === 'sign_out') await endSession(routing.message ?? 'auth.google.error.generic');
    })();

    return () => { cancelled = true; };
    // Deliberately not depending on loadUserProfile, which is re-created every
    // render; signOut is reached through its ref for the same reason. The ref
    // above is what keeps this to one run per session.
  }, [loading, user, session, profile]);

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
        // A company waiting for approval, or rejected, is not a reason to end
        // the session: App renders PendingApprovalPage or RejectedPage for it.
        // Signing those owners out left a newly registered owner on the login
        // form, unable to see the page that explains the wait.
        const approvalGateShowsIt = blockReason === 'company_pending' || blockReason === 'company_rejected';
        if (blockReason && !approvalGateShowsIt) {
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

    /*
      A sign-out that did not happen must not leave the session on screen.

      supabase-js reports most failures as a **value** and only the rest by
      throwing, so reading the exception alone left the caller signed in with
      nothing to show that anything had gone wrong. Read from the installed
      source (`@supabase/auth-js` 2.98.0, `GoTrueClient._signOut`): it POSTs
      `/logout` first and returns early with `{ error }` for any failure that
      is not 404, 401, 403 or a missing session, **before** `_removeSession()`
      — so on a dead network the stored session survives too. `scope: 'local'`
      is not a way around that: `GoTrueAdminApi.signOut` makes the same request
      whatever the scope.

      That is worst on the path this now matters for. A Google session refused
      for a platform account would keep `user`, the authenticated router would
      stay mounted, the address would say /login and nothing would render the
      sentence — the empty panel `googleSignInRefusal` exists to prevent.

      So both shapes are handled, and the local session is dropped here rather
      than left to a call that cannot do it offline: `AUTH_STORAGE_KEY` is the
      one place that name is written, and `clearSessionData()` is what the
      React tree reads. The refresh token stays valid at GoTrue until it
      expires — the cost of signing out with no network, and not an access
      grant: every platform capability is refused in the database, and a
      company user's rows are refused by RLS the moment the account is blocked.
    */
    const dropLocalSession = () => {
      try {
        localStorage.removeItem(AUTH_STORAGE_KEY);
      } catch (error) {
        // Blocked storage: the React state below is then the whole sign-out.
        console.error('Could not remove the stored session:', error);
      }
      clearSessionData();
    };

    try {
      const { error } = await supabase.auth.signOut();
      if (error) {
        console.error('Sign out failed:', error);
        dropLocalSession();
      }
    } catch (error) {
      console.error('Sign out exception:', error);
      dropLocalSession();
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
   * before it loads, and for a profile whose role resolves to no rows.
   *
   * Super admins pass unconditionally here, and since 20260917130000 (plan 3.3)
   * the database no longer agrees: `current_role_permits()` lost its
   * `is_user_super_admin()` term, and a platform account is judged by the role
   * its own profile carries. Nothing depends on the two agreeing, because a
   * platform account has no company and every tenant predicate asks
   * `get_active_company_id()`, which is NULL for it — so the screens this
   * unlocks reach no tenant row either way. 3.4 replaces this with the support
   * session, and the button should follow that, not the flag.
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

  // Subscription is active when status=active AND expiry is in the future (or
  // null = no expiry set = legacy active). The predicate is
  // `subscriptionIsActive()` and lives in `utils/planState.ts`, because
  // PlanContext decides the same question about the same company and the two
  // must not drift — from each other, or from `get_active_company_id()`.
  const isSubscriptionActive = subscriptionIsActive(subscriptionStatus, subscriptionExpiresAt);

  // The label for the screens: the database says `active`, but the subscription
  // is not. It asks `isSubscriptionActive` rather than comparing the expiry a
  // second time, so the word on the screen and the rule that decides access
  // cannot disagree — a date that does not parse now reads `expired` here as
  // well as failing the predicate, instead of being labelled `active`.
  const effectiveSubscriptionStatus: 'inactive' | 'active' | 'expired' | 'suspended' | null =
    subscriptionStatus === null ? null :
    subscriptionStatus === 'suspended' ? 'suspended' :
    subscriptionStatus === 'active' && !isSubscriptionActive ? 'expired' :
    subscriptionStatus;

  const clearAuthNotice = useCallback(() => setAuthNotice(null), []);

  /** Re-reads the caller's own profile after something changed it server-side. */
  const refreshProfile = async () => {
    if (!user) return;
    await loadUserProfile(user.id);
  };

  const refreshSubscription = async () => {
    if (!profile?.company_id) return;
    try {
      const { data: company } = await supabase
        .from('companies')
        .select('status, subscription_status, subscription_expires_at, approval_status, rejection_reason')
        .eq('id', profile.company_id)
        .maybeSingle();
      if (company) {
        setCompanyStatus(company.status as CompanyStatus);
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
    profileLoaded,
    profileLoadFailed,
    userBlockReason,
    session,
    loading,
    companyId,
    companyStatus,
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
    authNotice,
    setAuthNotice,
    clearAuthNotice,
    googleSignInIntent,
    refreshProfile,
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
