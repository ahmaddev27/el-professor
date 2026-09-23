import React, { Suspense, lazy } from 'react';
import { AlertCircle } from 'lucide-react';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { useAuth } from './contexts/AuthContext';
import { CompanySettingsProvider } from './contexts/CompanySettingsContext';
import { SuperAdminProvider, useSuperAdmin } from './contexts/SuperAdminContext';
import { PlanProvider, usePlan, FeatureKey } from './contexts/PlanContext';
import AppLayout from './components/AppLayout';
import LockedFeaturePage from './components/LockedFeaturePage';
import LoginForm from './components/LoginForm';
import LandingPage from './pages/LandingPage';
import ForgotPasswordPage from './pages/ForgotPasswordPage';
import AuthCallbackPage from './pages/AuthCallbackPage';
import SetPasswordPage from './pages/SetPasswordPage';
import VerifyEmailPage from './pages/VerifyEmailPage';
import InviteAcceptPage from './pages/InviteAcceptPage';
import SignupPage from './pages/SignupPage';
import CompleteRegistrationPage from './pages/CompleteRegistrationPage';
import OverviewPage from './pages/OverviewPage';
import AccountPage from './pages/AccountPage';
import BelegePage from './pages/BelegePage';
import FahrerPage from './pages/FahrerPage';
import CarsPage from './pages/CarsPage';
import UmsaetzePage from './pages/UmsaetzePage';
import FixkostenPage from './pages/FixkostenPage';
import SalariesPage from './pages/SalariesPage';
import BargeldbestandPage from './pages/BargeldbestandPage';
import WerkstattPage from './pages/WerkstattPage';
import { AbrechnungPage } from './pages/AbrechnungPage';
import { NotesPage } from './pages/NotesPage';
import UsersPage from './pages/UsersPage';
import RolesPage from './pages/RolesPage';
import DocumentsPage from './pages/DocumentsPage';
import StundennachweisPage from './pages/StundennachweisPage';
import SettingsPage from './pages/SettingsPage';
import CompaniesPage from './pages/CompaniesPage';
import SuperAdminDashboard from './pages/SuperAdminDashboard';
import NotificationsPage from './pages/NotificationsPage';
import CompanyPlannerPage from './pages/CompanyPlannerPage';
import SubscriptionBillingPage from './pages/SubscriptionBillingPage';
import CompanyBillingPage from './pages/CompanyBillingPage';
import AbnahmeDiagnosticPage from './pages/AbnahmeDiagnosticPage';
import PlatformDirectoriesPage from './pages/PlatformDirectoriesPage';
import PlatformAuditPage from './pages/PlatformAuditPage';
import PlatformSettingsPage from './pages/PlatformSettingsPage';
import PlatformTeamPage from './pages/PlatformTeamPage';
import PendingApprovalPage from './pages/PendingApprovalPage';
import RejectedPage from './pages/RejectedPage';
import CompanySuspendedPage from './pages/CompanySuspendedPage';
import ActivationPage from './pages/ActivationPage';
import AccountBlockedPage from './pages/AccountBlockedPage';
import AdminLayout from './components/AdminLayout';
import { useTranslation } from './contexts/LanguageContext';
import type { TranslationKey } from './i18n';
import { isDesignPreviewPath } from './design-preview/gate';
import LegalPage from './pages/LegalPage';
import { legalPageFor } from './lib/legalPages';
import { needsCompanyRegistration } from './lib/googleAccount';
import {
  ADMIN_BASE,
  ADMIN_LOGIN_PATH,
  LEGACY_ADMIN_BASE,
  SIGN_IN_PATH,
  TENANT_HOME,
  legacyAdminLoginRedirect,
  legacyAdminTarget,
  platformAccountRoute,
  platformEntry,
  platformEntryPath,
  rememberedPanelPath,
} from './lib/adminGate';

// ─── Design preview (Phase 2 prototype) ──────────────────────────────────────
// The new design on invented data, for the owner to approve before any screen
// moves over. __DESIGN_PREVIEW__ is false in production builds (vite.config.ts),
// which folds this to null and leaves the preview's code out of the bundle.
// Nothing links to it; it is reached by typing /design-preview.
const DesignPreviewApp = __DESIGN_PREVIEW__ ? lazy(() => import('./design-preview/DesignPreviewApp')) : null;

// ─── Plan-gated route wrapper ─────────────────────────────────────────────────

// The name LockedFeaturePage puts in "X is not included in your plan", as
// translation keys — the map is module-level and cannot call t() itself.
// Werkstatt, Abrechnung, Stundennachweis and Trinkgeld Quittung resolve to
// themselves in English: they are the domain vocabulary listed in i18n/index.ts,
// and the locked screen has to name the feature the way the nav does.
const FEATURE_LABEL_KEYS: Partial<Record<FeatureKey, TranslationKey>> = {
  werkstatt:            'nav.werkstatt',
  abrechnung:           'nav.abrechnung',
  notizen:              'nav.notes',
  rollen_nutzer:        'locked.feature.rollenNutzer',
  benachrichtigungen:   'nav.notifications',
  gehaelter:            'nav.salaries',
  dokumente:            'nav.documents',
  trinkgeld_quittung:   'locked.feature.trinkgeld',
  stundennachweis:      'locked.feature.stundennachweis',
};

const PlanGate: React.FC<{ feature: FeatureKey; children: React.ReactNode }> = ({ feature, children }) => {
  // The plan a feature needs comes from the database's feature map (plan 3.9),
  // through PlanContext, so the locked screen names the same plan the gate used.
  const { can, minPlanFor } = usePlan();
  const { t } = useTranslation();
  if (can(feature)) return <>{children}</>;
  const labelKey = FEATURE_LABEL_KEYS[feature];
  return (
    <LockedFeaturePage
      featureName={labelKey ? t(labelKey) : feature}
      requiredPlan={minPlanFor(feature)}
    />
  );
};

// ─── Must-change-password guard (must live inside BrowserRouter) ────────────
// If an authenticated user has must_change_password=true, block all routes
// except the password-change page and logout. Redirect to /set-new-password.

const PASSWORD_CHANGE_ALLOWED_PATHS = ['/set-new-password'];

const MustChangePasswordGuard: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { mustChangePassword } = useAuth();
  const location = useLocation();

  if (mustChangePassword && !PASSWORD_CHANGE_ALLOWED_PATHS.includes(location.pathname)) {
    return <Navigate to="/set-new-password" replace />;
  }

  return <>{children}</>;
};

// ─── Subscription guard (must live inside BrowserRouter) ─────────────────────
// Redirects to /abo-aktivieren when an approved company's subscription is inactive.
// Allows through: activation page, billing page, and auth routes.

const SUBSCRIPTION_ALLOWED_PATHS = ['/abo-aktivieren', '/aktivierung', '/billing'];

const SubscriptionGuard: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { isSuperAdmin, companyApprovalStatus, isSubscriptionActive, profile } = useAuth();
  const location = useLocation();

  if (
    !isSuperAdmin &&
    companyApprovalStatus === 'approved' &&
    !!profile?.company_id &&
    !isSubscriptionActive &&
    !SUBSCRIPTION_ALLOWED_PATHS.includes(location.pathname)
  ) {
    return <Navigate to="/abo-aktivieren" replace />;
  }

  return <>{children}</>;
};

/**
 * A super admin is a platform account, not a tenant.
 *
 * Detached from a company, its `effectiveCompanyId` is null until it enters
 * one — and every tenant screen then queries `company_id = null`. PostgREST
 * serialises that as the string "null", so Postgres answers
 *
 *   invalid input syntax for type uuid: "null"
 *
 * as a banner over zeroed figures on a page that has already rendered.
 *
 * Sending the account to the platform panel is not a workaround for that
 * error, it is the model: a super admin reaches a company's screens by
 * entering it from /admin, which sets effectiveCompanyId, and the same
 * screens then work against that company.
 *
 * Outermost of the three guards, so it settles the question before
 * SubscriptionGuard can route a company-less account to /abo-aktivieren.
 */
/**
 * Where a company-less platform account goes instead of a tenant path.
 *
 * `/mein-konto` used to be let through this guard, which kept the account on a
 * route registered inside AppLayout: the company sidebar, with fourteen tenant
 * screens the account can never open, wrapped around a page that said it had no
 * company. The account page itself is not the problem — AccountPage reads only
 * the caller's own record (no company settings, no plan, no company id) — so it
 * is registered a second time at `/admin/konto`, under AdminLayout, where
 * it renders identically inside the shell the account actually belongs to.
 *
 * The old path stays a working bookmark by redirecting here rather than falling
 * through to the dashboard, which would silently drop whoever followed it.
 */
const PLATFORM_ACCOUNT_REDIRECTS: Record<string, string> = {
  '/mein-konto': '/admin/konto',
};

const PlatformAccountGuard: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { isSuperAdmin } = useAuth();
  const { effectiveCompanyId, platformAccessStatus } = useSuperAdmin();
  const location = useLocation();

  /*
    Three answers, not two, and the third is why a reload used to throw a
    support session out of the company it was working in: on a fresh load this
    guard ran before `platform_whoami()` had answered, read "no company" out of
    an unanswered question, and redirected to /admin — where the context then
    arrived and the bar named a company that was no longer on screen.

    The rule is `platformAccountRoute()`, kept pure and tested beside the other
    two routing decisions. `wait` is a spinner and never a pass: see that
    function for what "assume allowed" cost the last time.
  */
  const route = platformAccountRoute({
    isSuperAdmin,
    platformAccessStatus,
    hasCompany: effectiveCompanyId !== null,
  });

  if (route === 'wait') return <AuthLoadingScreen />;
  if (route === 'panel') {
    return <Navigate to={PLATFORM_ACCOUNT_REDIRECTS[location.pathname] ?? ADMIN_BASE} replace />;
  }

  return <>{children}</>;
};

/**
 * The tenant shell, keyed on the company the session is in (plan 3.4b).
 *
 * Before this slice `effectiveCompanyId` could not move while a tenant screen
 * was mounted: it was React state, set by a click in the panel that had already
 * navigated away from the tenant app. Now it is the database's answer, so it
 * *can* move underneath a mounted screen — a second tab opens another company,
 * this tab regains focus, `platform_whoami()` answers the new one.
 *
 * Most tenant screens load once and keep the rows in state. `useDatabase`'s four
 * (`OverviewPage`, `BelegePage`, `FahrerPage`, `UmsaetzePage`) key their load
 * effect on `dbLoading` alone, and there are more of the same shape behind the
 * plan gates. Meanwhile `CompanySettingsContext` *does* follow the company, so
 * the sidebar name, the logo and every document header would become company B
 * while the figures on screen were still company A's — no leak, since the rows
 * were read under A's own policy, but a payroll figure presented under the
 * wrong customer's name, with nothing on screen to say so.
 *
 * A key is one line and covers every screen, including the ones nobody has
 * thought about yet; patching four dependency arrays fixes four screens and
 * leaves the next one to be found by a customer. The cost is a remount and a
 * refetch when the company changes — which is exactly what should happen.
 */
const TenantShell: React.FC<{ isSupportAdmin: boolean }> = ({ isSupportAdmin }) => {
  const { effectiveCompanyId } = useSuperAdmin();
  return <AppLayout key={effectiveCompanyId ?? 'no-company'} isSupportAdmin={isSupportAdmin} />;
};

/**
 * A route a company administrator may open — and a platform account inside a
 * company, which is what the four screens behind it are for.
 *
 * `isAdmin` is `user_profiles.role === 'admin'`, and a platform account's
 * profile carries `viewer` (that is what `platform-staff` writes for every
 * invited member), so registering these routes on it left Benutzer, Rollen,
 * Abonnement and Einstellungen unreachable for exactly the accounts a support
 * session exists for. The screens themselves decide what may be *written*
 * there: a read context is refused by `refuse_read_only_context_write` and by
 * `current_role_permits`, and `useCompanyScope()` is how each one asks.
 */
const CompanyAdminRoute: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { isAdmin } = useAuth();
  const { companyScope } = useSuperAdmin();
  if (!isAdmin && !companyScope.isPlatformSession) {
    return <Navigate to={TENANT_HOME} replace />;
  }
  return <>{children}</>;
};

/** The full-page spinner shown while the session, or its profile, is still being read. */
const AuthLoadingScreen: React.FC = () => (
  <div className="min-h-screen bg-[#060a0f] flex items-center justify-center">
    <div className="text-center">
      <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-cyan-400 mx-auto mb-4" />
      <p className="text-white/40 text-sm">Wird geladen...</p>
    </div>
  </div>
);

/**
 * `/login` — the one sign-in screen (the owner's decision of 17.09.2026).
 *
 * Platform accounts and company users type their password in the same place,
 * and the account decides where the session goes: `/admin` for a platform
 * account, its own app for everyone else. Nothing knows which it is before the
 * session exists, so the screen is the company one, Google button and all —
 * and a platform account that presses that button is refused with a sentence
 * (AuthContext, `googleSignInRefusal`), not with an empty panel.
 *
 * Registered in both routers, because it has to answer for a browser with no
 * session and for one that has just acquired a session on this very page:
 * signing in swaps App's public router for the authenticated one, which starts
 * at whatever the address bar still says. Deciding here, rather than with a
 * navigate() inside the form, is what keeps that redirect out of the router
 * being unmounted — the same reason useOtpSessionHandoff rewrites the address
 * before it installs a session.
 *
 * Who goes where is `platformEntry()`, kept pure and covered by tests.
 */
const SignInRoute: React.FC = () => {
  const { user, profileLoaded, loading, isSuperAdmin } = useAuth();
  const location = useLocation();
  const entry = platformEntry({
    authLoading: loading,
    hasSession: !!user,
    profileLoaded,
    isSuperAdmin,
  });

  if (entry === 'loading') return <AuthLoadingScreen />;
  if (entry === 'signIn') return <LoginForm />;

  // Back to the page the visitor asked for before signing in, when there was
  // one and it is a panel path — `rememberedPanelPath` is where that is
  // decided, and it validates the value again rather than trusting the one
  // `/admin/login` or PlatformSignInRedirect already checked. Only for an
  // account the panel is actually for: a company user has no business at
  // /admin/protokoll, so it goes to its own app whatever the browser remembers.
  const returnTo = entry === 'panel' ? rememberedPanelPath(location.state) : null;

  // A company user that signs in here belongs in its own app, not in a shell
  // with nothing it may open. Refusing it a session instead would be a
  // permission notion of the browser's own invention: what any account may
  // actually do is decided in the database, on every call.
  return <Navigate to={returnTo ?? platformEntryPath(entry) ?? TENANT_HOME} replace />;
};

/**
 * `/admin/login` — the panel's own front door for one day, 16.–17.09.2026.
 *
 * It is not deleted, it redirects: a bookmark taken that day, and anything
 * still linking there, land on the one sign-in screen with the remembered
 * return path intact. Registered in both routers for the same reason
 * `SignInRoute` is — a browser can be on it with or without a session.
 */
const AdminLoginRedirect: React.FC = () => {
  const location = useLocation();
  const { to, from } = legacyAdminLoginRedirect(location.state);
  return <Navigate to={to} state={from ? { from } : undefined} replace />;
};

/**
 * `/super-admin/*` — the panel's previous entry.
 *
 * Slice 3.13b removed the last in-app link to it: the company sidebar, the user
 * menu, the overview card and the platform dashboard's own links all name
 * ADMIN_BASE now, so nothing in the product produces one of these paths any
 * more. **The redirect itself stays**, and on purpose — a bookmark, a browser's
 * autocomplete and a link in somebody's notes outlive the release that stopped
 * writing the path, and an operator following one should land on the panel
 * rather than on the marketing page through the public catch-all.
 *
 * The panel is registered once, under `/admin`, and every old path is rewritten
 * onto it here, so there is no second copy of the routes that could drift from
 * the first.
 */
const LegacyAdminRedirect: React.FC = () => {
  const location = useLocation();
  const target = legacyAdminTarget(location.pathname) ?? ADMIN_BASE;
  return <Navigate to={`${target}${location.search}${location.hash}`} replace />;
};

/**
 * A platform path asked for without a session: the one sign-in screen,
 * remembering where the visitor was going.
 *
 * It answers for the old entry as well as the new one — signed out is exactly
 * when a `/super-admin` bookmark gets followed, and without this it lands on the
 * marketing landing page through the public catch-all.
 *
 * The remembered path travels in the router's own location state rather than in
 * the query string, so it never appears in the address bar. It is not trusted
 * on the way back: `rememberedPanelPath` validates it, here and again at the
 * sign-in screen.
 */
const PlatformSignInRedirect: React.FC = () => {
  const location = useLocation();
  const intended = legacyAdminTarget(location.pathname) ?? location.pathname;
  const from = rememberedPanelPath({ from: intended });
  return <Navigate to={SIGN_IN_PATH} state={from ? { from } : undefined} replace />;
};

/**
 * The profile never answered, after the bounded retries in AuthContext.
 *
 * The gate above stays closed — a profile that did not load must never be read
 * as an account without one — so this is what keeps that from being an
 * indefinite spinner: nothing else reloads the profile until a token refresh or
 * a page reload, which can be an hour away.
 */
const ProfileUnavailableScreen: React.FC<{ onRetry: () => void; onSignOut: () => void }> = ({ onRetry, onSignOut }) => {
  const { t } = useTranslation();

  return (
    <div className="min-h-screen bg-[#060a0f] flex items-center justify-center p-4">
      <div className="w-full max-w-sm text-center bg-white/4 backdrop-blur-xl border border-white/10 rounded-2xl p-7">
        <div className="w-12 h-12 rounded-full bg-amber-500/15 border border-amber-500/30 flex items-center justify-center mx-auto mb-4">
          <AlertCircle className="text-amber-400" size={22} aria-hidden="true" />
        </div>
        <h2 className="text-white font-semibold mb-2">{t('profile.unavailable.title')}</h2>
        <p className="text-white/60 text-sm leading-relaxed mb-6">{t('profile.unavailable.body')}</p>
        <div className="flex flex-col gap-2">
          <button
            onClick={onRetry}
            className="w-full bg-gradient-to-r from-cyan-500 to-blue-600 text-white py-3 px-4 rounded-xl font-semibold text-sm"
          >
            {t('profile.unavailable.retry')}
          </button>
          <button
            onClick={onSignOut}
            className="w-full text-white/50 hover:text-white/80 text-sm py-2 transition-colors"
          >
            {t('common.logout')}
          </button>
        </div>
      </div>
    </div>
  );
};

// ─── App ──────────────────────────────────────────────────────────────────────

function App() {
  const { user, profile, profileLoaded, profileLoadFailed, refreshProfile, signOut, loading: authLoading, isAdmin, isSuperAdmin, companyStatus, companyApprovalStatus, userBlockReason } = useAuth();

  // Ahead of every gate: the preview reads no account or tenant data, and it
  // has to render for a reviewer whatever their session state is.
  if (DesignPreviewApp && isDesignPreviewPath(window.location.pathname)) {
    return (
      <Suspense fallback={null}>
        <DesignPreviewApp />
      </Suspense>
    );
  }

  // Ahead of every gate too, and in every build: the Impressum and the privacy
  // policy read only public data, and a German commercial site owes both to
  // everyone — signed out, blocked, pending approval or signed in. The links to
  // them are plain page loads, so the path is read here and not by a router.
  const legalPage = legalPageFor(window.location.pathname);
  if (legalPage) {
    return <LegalPage page={legalPage} />;
  }

  if (authLoading) {
    return <AuthLoadingScreen />;
  }

  if (!user) {
    return (
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<LandingPage />} />
          {/* The one sign-in screen, for platform accounts and company users
              alike (the owner's decision of 17.09.2026). Without a session it
              renders the form; the account is routed once it has one. */}
          <Route path={SIGN_IN_PATH} element={<SignInRoute />} />
          <Route path="/auth/forgot-password" element={<ForgotPasswordPage />} />
          <Route path="/auth/callback" element={<AuthCallbackPage />} />
          <Route path="/auth/set-password" element={<SetPasswordPage />} />
          <Route path="/set-new-password" element={<SetPasswordPage />} />
          <Route path="/auth/verify-email" element={<VerifyEmailPage />} />
          <Route path="/einladung" element={<InviteAcceptPage />} />
          <Route path="/signup" element={<SignupPage />} />
          {/* The panel's own front door of 16.–17.09.2026, kept as a redirect
              onto the sign-in screen above. Anything else under /admin without
              a session goes there too, remembering where it was headed: the
              panel is never rendered for a browser that has no account at all.
              The old entry answers here as well — signed out is exactly when a
              /super-admin bookmark is followed, and the public catch-all below
              would otherwise drop it on the landing page. */}
          <Route path={ADMIN_LOGIN_PATH} element={<AdminLoginRedirect />} />
          <Route path={`${ADMIN_BASE}/*`} element={<PlatformSignInRedirect />} />
          <Route path={`${LEGACY_ADMIN_BASE}/*`} element={<PlatformSignInRedirect />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    );
  }

  // Every gate below reads the profile, and a null one means two different
  // things: the query has not answered yet (or failed), or this account has no
  // row. Waiting here is what keeps the first from being read as the second —
  // one failed profile load after a Google redirect otherwise fell past the
  // registration gate and the approval gates into the tenant router, with no
  // company at all. The gates themselves are unchanged, and in the ordinary
  // case the profile is already loaded when `authLoading` clears.
  if (!profileLoaded) {
    // Retrying clears the failure in AuthContext, so this falls back to the
    // spinner while the next attempts run.
    return profileLoadFailed
      ? <ProfileUnavailableScreen onRetry={() => { void refreshProfile(); }} onSignOut={() => { void signOut(); }} />
      : <AuthLoadingScreen />;
  }

  // Account revocation gate. Runs before the company gates because it is the
  // narrower block: a deactivated user must be stopped even while their company
  // is perfectly healthy. signIn() already refuses these accounts; this catches
  // restored sessions and sessions installed from a one-time code, where
  // signIn() never runs.
  if (userBlockReason) {
    return <AccountBlockedPage reason={userBlockReason} />;
  }

  // A Google account that has registered no company yet (plan 1.6). Ahead of
  // the approval gates because none of them can answer for it: there is no
  // company to be pending, rejected or suspended. Without this the
  // authenticated router would send it to /overview, where every tenant query
  // asks for company_id null and PostgREST sends Postgres the string "null".
  if (needsCompanyRegistration(user, profile)) {
    return <CompleteRegistrationPage />;
  }

  // Approval status gates — only for non-super-admins with a company
  if (!isSuperAdmin && companyApprovalStatus === 'pending') {
    return <PendingApprovalPage />;
  }
  if (!isSuperAdmin && companyApprovalStatus === 'rejected') {
    return <RejectedPage />;
  }
  /*
    Suspension, from the one column that records it.

    `companyStatus` is the test since 20260919150000 (plan 3.F step U1), which
    moved every suspended flag onto `companies.status` and stopped
    `approval_status` and `subscription_status` from carrying the value at all.
    Before that this gate read `companyApprovalStatus`, and only
    `platform_company_set_approval('suspend')` ever set it — a suspension from
    the lifecycle menu was visible instead through the *profile* status it also
    writes, which gate 3 above catches. Reading the approval status alone would
    now let a suspended company through to `/overview` and tell it, through
    `LockedFeaturePage`, that its plan was too low.

    `companyApprovalStatus` is kept in the test so that a rollback to the
    previous release, which leaves this database as it is, still blocks a
    company that was suspended before the migration ran and never re-read.
  */
  if (!isSuperAdmin && (companyStatus === 'suspended' || companyApprovalStatus === 'suspended')) {
    return <CompanySuspendedPage />;
  }

  /*
    SuperAdminProvider is outermost of the three since 3.4b.

    It answers which company the session is actually in — its own for a company
    user, the open support context's for a platform account — and both providers
    below it now ask it that, rather than reading the membership in AuthContext,
    which is null for a platform account and so left every screen under them
    querying `company_id = null`. SuperAdminProvider itself reads only
    AuthContext, so nothing is inverted by the move.
  */
  return (
    <SuperAdminProvider>
      <CompanySettingsProvider>
        <PlanProvider>
          <BrowserRouter>
            <Routes>
              <Route path="/auth/callback" element={<AuthCallbackPage />} />
              <Route path="/auth/set-password" element={<SetPasswordPage />} />
              <Route path="/set-new-password" element={<SetPasswordPage />} />
              <Route path="/auth/forgot-password" element={<ForgotPasswordPage />} />
              <Route path="/einladung" element={<InviteAcceptPage />} />
              {/* Already signed in: the sign-in screen sends the account on to
                  the panel, or to its own app when the panel is not for it —
                  and to the panel page it was heading for before it signed in,
                  which is what registering /login here is for. The old panel
                  front door redirects onto it, carrying that path along. */}
              <Route path={SIGN_IN_PATH} element={<SignInRoute />} />
              <Route path={ADMIN_LOGIN_PATH} element={<AdminLoginRedirect />} />
              <Route path="/" element={
                <PlatformAccountGuard>
                <MustChangePasswordGuard>
                <SubscriptionGuard>
                  <TenantShell isSupportAdmin={isAdmin} />
                </SubscriptionGuard>
                </MustChangePasswordGuard>
                </PlatformAccountGuard>
              }>
                <Route index element={<Navigate to={isSuperAdmin ? ADMIN_BASE : "/overview"} replace />} />
                {/* Activation routes — inside AppLayout so sidebar is visible */}
                <Route path="abo-aktivieren" element={<ActivationPage />} />
                <Route path="aktivierung"    element={<ActivationPage />} />
                {/* Basic features — always accessible */}
                <Route path="mein-konto"     element={<AccountPage />} />
                <Route path="overview"       element={<OverviewPage />} />
                <Route path="belege"         element={<BelegePage />} />
                <Route path="fahrer"         element={<FahrerPage />} />
                <Route path="cars"           element={<CarsPage />} />
                <Route path="umsaetze"       element={<UmsaetzePage />} />
                <Route path="fixkosten"      element={<FixkostenPage />} />
                <Route path="bargeldbestand" element={<BargeldbestandPage />} />
                {/* Advanced features */}
                <Route path="werkstatt"  element={<PlanGate feature="werkstatt"><WerkstattPage /></PlanGate>} />
                <Route path="abrechnung" element={<PlanGate feature="abrechnung"><AbrechnungPage /></PlanGate>} />
                <Route path="notes"              element={<PlanGate feature="notizen"><NotesPage /></PlanGate>} />
                <Route path="benachrichtigungen" element={<PlanGate feature="benachrichtigungen"><NotificationsPage /></PlanGate>} />
                {/* Premium features */}
                <Route path="salaries"       element={<PlanGate feature="gehaelter"><SalariesPage /></PlanGate>} />
                <Route path="dokumente"              element={<PlanGate feature="dokumente"><DocumentsPage /></PlanGate>} />
                <Route path="dokumente/:id"          element={<PlanGate feature="dokumente"><DocumentsPage /></PlanGate>} />
                <Route path="dokumente/:id/bearbeiten" element={<PlanGate feature="dokumente"><DocumentsPage /></PlanGate>} />
                <Route path="stundennachweis" element={<PlanGate feature="dokumente"><StundennachweisPage /></PlanGate>} />
                <Route path="company-planner" element={<PlanGate feature="dokumente"><CompanyPlannerPage /></PlanGate>} />
                {/* An administrator of this company — or a platform account
                    inside it (3.4b). Registered unconditionally and decided in
                    CompanyAdminRoute, because the answer needs the session's
                    company and this element tree is built above the providers
                    that know it. */}
                <Route path="users"    element={<CompanyAdminRoute><PlanGate feature="rollen_nutzer"><UsersPage /></PlanGate></CompanyAdminRoute>} />
                <Route path="roles"    element={<CompanyAdminRoute><PlanGate feature="rollen_nutzer"><RolesPage /></PlanGate></CompanyAdminRoute>} />
                <Route path="billing"  element={<CompanyAdminRoute><CompanyBillingPage /></CompanyAdminRoute>} />
                <Route path="settings" element={<CompanyAdminRoute><SettingsPage /></CompanyAdminRoute>} />
                <Route path="*" element={<Navigate to="/overview" replace />} />
              </Route>

              {/* Platform administration — its own shell, with no company
                  navigation, at its own entry since plan slice 3.6a. Registered
                  only for super admins, and AdminLayout re-checks against
                  platform_whoami(), so a direct URL cannot land a tenant user
                  here: for it, /admin falls through to the tenant catch-all
                  above and ends on /overview. */}
              {isSuperAdmin && (
                <Route path={ADMIN_BASE} element={<AdminLayout />}>
                  <Route index                   element={<SuperAdminDashboard />} />
                  <Route path="companies"        element={<CompaniesPage />} />
                  <Route path="billing"          element={<SubscriptionBillingPage />} />
                  <Route path="abnahme-diagnose" element={<AbnahmeDiagnosticPage />} />
                  {/* Each of these checks its own capability again, and every
                      RPC behind them checks it a third time in the database. */}
                  <Route path="verzeichnisse"    element={<PlatformDirectoriesPage />} />
                  <Route path="protokoll"        element={<PlatformAuditPage />} />
                  <Route path="einstellungen"    element={<PlatformSettingsPage />} />
                  <Route path="team"             element={<PlatformTeamPage />} />
                  {/* The same AccountPage the company shell registers. It reads
                      only the caller's own record, so it needs nothing this
                      shell does not provide, and a platform account changes its
                      own name, address and password without being handed a
                      company sidebar it cannot use. Before the catch-all. */}
                  <Route path="konto"            element={<AccountPage />} />
                  <Route path="*" element={<Navigate to={ADMIN_BASE} replace />} />
                </Route>
              )}

              {/* The panel's previous entry. One panel and not two: every
                  /super-admin path is rewritten onto /admin, for a platform
                  account and a company user alike. Slice 3.13b removed the
                  links that pointed at it; this stays for the bookmarks that
                  already exist. */}
              <Route path={`${LEGACY_ADMIN_BASE}/*`} element={<LegacyAdminRedirect />} />
            </Routes>
          </BrowserRouter>
        </PlanProvider>
      </CompanySettingsProvider>
    </SuperAdminProvider>
  );
}

export default App;
